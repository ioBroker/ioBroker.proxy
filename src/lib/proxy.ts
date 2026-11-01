import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { extname, normalize } from 'node:path';

import axios, { type AxiosResponse, type RawAxiosRequestHeaders } from 'axios';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import * as mime from 'mime';

import type { NextFunction, ProxyRequest, ProxyResponse, ProxyRule, WebApp } from './types';
import { maskUrl, toInt } from './utils';

/** `request` (used by the simple proxy before axios) did not follow redirects for these methods */
const NO_REDIRECT_METHODS = ['PATCH', 'PUT', 'POST', 'DELETE'];
/** Default of `maxRedirects` in `request` */
const MAX_REDIRECTS = 10;

/**
 * Removes `user:pass@` from the URL and returns the decoded credentials separately, like `request` did.
 * axios would take them from the URL too, but without decoding the percent-encoding.
 */
function splitCredentials(url: string): { url: string; auth?: { username: string; password: string } } {
    const m = url.match(/^(https?:\/\/)([^/@]+)@/i);
    if (!m) {
        return { url };
    }
    const [username, ...password] = m[2].split(':').map(part => decodeURIComponent(part));
    return { url: url.replace(m[0], m[1]), auth: { username, password: password.join(':') } };
}

/**
 * Proxy web extension. It is loaded by the web adapter (see `common.webExtension` in io-package.json),
 * when `native.webInstance` of this instance points to that web instance.
 *
 * The settings of the web server are not used.
 */
class ProxyExtension {
    private readonly app: WebApp;
    /** The web adapter, not this one */
    private readonly adapter: ioBroker.Adapter;
    private readonly config: ioBroker.AdapterConfig;
    /** "proxy.0" - the namespace of THIS instance, not the one of web */
    private readonly namespace: string;
    private readonly simpleProxy: boolean;
    private readonly route: string;
    private readonly errorTimeout: number;
    private readonly parallelRequests: number;
    private readonly rules: ProxyRule[];
    private interval: ioBroker.Interval | null | undefined = null;

    /**
     * @param _server http or https node.js server of the web adapter
     * @param _webSettings settings of the web server, like `{ secure: settings.secure, port: settings.port }`
     * @param adapter the web adapter, not this one
     * @param instanceSettings instance object of this proxy instance with common and native
     * @param app express application of the web adapter
     */
    public constructor(
        _server: Server,
        _webSettings: Record<string, unknown>,
        adapter: ioBroker.Adapter,
        instanceSettings: ioBroker.InstanceObject | undefined,
        app: WebApp,
    ) {
        this.app = app;
        this.adapter = adapter;
        this.config = (instanceSettings ? instanceSettings.native : {}) as ioBroker.AdapterConfig;
        // 'simple-api' is a copy & paste leftover, web always delivers instanceSettings
        this.namespace = instanceSettings ? instanceSettings._id.substring('system.adapter.'.length) : 'simple-api';
        // the old admin stored the checkbox as string
        this.simpleProxy = this.config.simpleProxy === true || this.config.simpleProxy === 'true';

        this.errorTimeout = toInt(this.config.errorTimeout) || 10000;
        this.parallelRequests = toInt(this.config.parallelRequests) || 10;
        if (this.errorTimeout < 1000) {
            this.errorTimeout = 1000;
        }

        let route = this.config.route || `${this.namespace}/`;
        // remove leading slash
        if (route[0] === '/') {
            route = route.substring(1);
        }
        this.route = route;

        this.rules = (this.config.rules || []).map(rule => ({
            regex: rule.regex,
            url: rule.url,
            timeout: toInt(rule.timeout) || this.errorTimeout,
            parallelRequests: toInt(rule.parallelRequests) || this.parallelRequests,
        }));

        if (!this.simpleProxy) {
            this.interval = this.adapter.setInterval(() => this.checkTimeouts(), 10000);
        }

        for (const rule of this.rules) {
            this.oneRule(rule);
        }
    }

    /** Drops finished requests and requests that exceeded the timeout of their rule */
    private checkTimeouts(): void {
        const now = Date.now();
        for (const rule of this.rules) {
            if (!rule.request) {
                continue;
            }

            for (let u = rule.request.length - 1; u >= 0; u--) {
                if (rule.request[u].res.writableEnded) {
                    rule.request.splice(u, 1);
                } else if (now - rule.request[u].ts > rule.timeout) {
                    rule.lastError = Date.now();
                    rule.lastErrorText = 'timeout';

                    this.adapter.log.error(
                        `[proxy] Cannot ${rule.request[u].req.method} "${rule.request[u].req.url}": timeout`,
                    );
                    rule.request.splice(u, 1);
                }
            }
        }
    }

    private finishReq(rule: ProxyRule, req: ProxyRequest, res: ProxyResponse): void {
        if (rule.request) {
            const pos = rule.request.findIndex(e => e.res === res);
            if (pos === -1) {
                this.adapter.log.error(`Request ${req.method} "${req.url}" not found in requests`);
            } else {
                rule.request.splice(pos, 1);
            }
        } else {
            this.adapter.log.error(`Request ${req.method} "${req.url}" not found in requests`);
        }
    }

    private oneRule(rule: ProxyRule): void {
        this.adapter.log.info(`Install extension on /${this.route}${rule.regex}`);

        if (rule.url.match(/^https?:\/\//)) {
            if (this.simpleProxy) {
                this.installSimpleProxy(rule);
            } else {
                this.installProxy(rule);
            }
        } else {
            this.installFileHandler(rule);
        }
    }

    private installSimpleProxy(rule: ProxyRule): void {
        this.app.use(`/${this.route}${rule.regex}`, (req, res) => {
            const now = Date.now();
            if (rule.lastError && now - rule.lastError < this.errorTimeout) {
                res.status(rule.lastStatusCode || 500).send(`[proxy] Cannot read file: ${rule.lastErrorText}`);
                return;
            }
            void this.simpleRequest(rule, req, res);
        });
    }

    /** Fetches the URL and sends the answer as a whole. The request body is not forwarded. */
    private async simpleRequest(rule: ProxyRule, req: ProxyRequest, res: ProxyResponse): Promise<void> {
        const { url, auth } = splitCredentials(rule.url + req.url);
        const headers = { ...req.headers } as RawAxiosRequestHeaders;
        // axios would ask for gzip itself; `request` sent the headers unchanged and the body is forwarded as is.
        // `false` suppresses the default header of axios.
        if (!headers['accept-encoding']) {
            headers['accept-encoding'] = false;
        }

        // like `request`: credentials from the URL only if the client did not send own ones
        let basicAuth = auth && !req.headers.authorization ? auth : undefined;
        const followRedirects = !NO_REDIRECT_METHODS.includes(req.method);

        let response: AxiosResponse<Buffer> | undefined;
        let error: Error | undefined;
        try {
            let currentUrl = url;
            for (let redirects = 0; ; redirects++) {
                response = await axios.request<Buffer>({
                    url: currentUrl,
                    method: req.method,
                    headers,
                    auth: basicAuth,
                    timeout: rule.timeout,
                    responseType: 'arraybuffer',
                    // forward the body exactly as received, together with its content-encoding header
                    decompress: false,
                    // every status is handled below
                    validateStatus: () => true,
                    // Redirects are followed below like `request` did it. follow-redirects would resolve
                    // a relative location against the forwarded host header, which is the one of web.
                    maxRedirects: 0,
                });
                const location = response.headers.location as string | undefined;
                if (
                    !followRedirects ||
                    !location ||
                    response.status < 300 ||
                    response.status >= 400 ||
                    redirects >= MAX_REDIRECTS
                ) {
                    break;
                }
                const nextUrl = new URL(location, currentUrl);
                // `request` removed the host header on redirects and the credentials if the host changed
                delete headers.host;
                if (nextUrl.hostname !== new URL(currentUrl).hostname) {
                    delete headers.authorization;
                    basicAuth = undefined;
                }
                currentUrl = nextUrl.toString();
            }
        } catch (e) {
            error = e as Error;
        }

        if (error || !response || response.status !== 200) {
            rule.lastError = Date.now();
            rule.lastErrorText = error ? error.toString() : (response?.data ?? '').toString();
            rule.lastStatusCode = response ? response.status || 500 : 500;
            res.status(rule.lastStatusCode).send(rule.lastErrorText);
        } else {
            rule.lastError = 0;
            rule.lastErrorText = '';
            rule.lastStatusCode = 200;
            for (const [key, value] of Object.entries(response.headers)) {
                if (value !== undefined && value !== null) {
                    res.set(key, Array.isArray(value) ? value.map(v => String(v)) : String(value));
                }
            }
            res.send(response.data || '');
        }
    }

    private installProxy(rule: ProxyRule): void {
        const options: Options = {
            target: rule.url,
            ws: true,
            secure: false,
            changeOrigin: false,
            proxyTimeout: rule.timeout,
            timeout: rule.timeout,
            xfwd: true,
            onError: (err, req, res /* , target*/) => {
                const response = res as ProxyResponse;
                rule.lastError = Date.now();
                rule.lastErrorText = err.toString();

                this.adapter.log.error(`[proxy] Proxy error "${maskUrl(rule.url)}": ${err.toString()}`);
                // for web sockets `res` is the socket
                if (!response.writableEnded) {
                    try {
                        if (typeof response.status === 'function') {
                            response.status(500).send(err);
                        } else if (typeof response.send === 'function') {
                            response.send(err);
                        } else {
                            this.adapter.log.error('[proxy] Cannot response');
                        }
                    } catch (e) {
                        this.adapter.log.error(`[proxy] Cannot response: ${(e as Error).toString()}`);
                    }
                }

                this.finishReq(rule, req, response);
            },
            onProxyReq: proxyReq => this.adapter.log.debug(`${proxyReq.method}: ${maskUrl(rule.url + proxyReq.path)}`),
            onProxyRes: (_proxyRes, req, res) => {
                this.finishReq(rule, req, res);
                rule.lastError = 0;
                rule.lastErrorText = '';
                this.adapter.log.debug(`[proxy] Response for ${req.url}: ${res.statusCode}(${res.statusMessage})`);
            },
            onOpen: proxySocket => {
                proxySocket?.on('error', err => this.adapter.log.info(`[proxy] Socket Error: ${err.toString()}`));
            },
            onProxyReqWs: (proxyReq, req, socket /* , options, head*/) => {
                this.adapter.log.debug(`${proxyReq.method} (WS): ${maskUrl(rule.url + proxyReq.path)}`);
                socket?.on('error', err =>
                    this.adapter.log.info(`[proxy] Socket Error for ${req.url}: ${err.toString()}`),
                );
            },
            pathRewrite: {},
        };
        const m = rule.url.match(/^https?:\/\/(.+)@/);
        if (m?.[1]?.includes(':')) {
            rule.url = rule.url.replace(`${m[1]}@`, '');
            options.auth = decodeURIComponent(m[1]);
            options.target = rule.url;
        }

        (options.pathRewrite as Record<string, string>)[`^/${this.route}${rule.regex}`] = '/';

        // never log credentials extracted from the rule URL
        this.adapter.log.debug(
            JSON.stringify({
                ...options,
                target: maskUrl(options.target as string),
                auth: options.auth ? '***' : undefined,
            }),
        );

        const handler = createProxyMiddleware(options);
        rule.handler = handler;
        this.app.use(`/${this.route}${rule.regex}`, (req, res, next) => {
            const now = Date.now();
            if (rule.lastError && now - rule.lastError < this.errorTimeout) {
                res.status(404).send(`[proxy] Cannot read file: ${rule.lastErrorText}`);
                return;
            }

            if (rule.request && rule.request.length > rule.parallelRequests) {
                res.status(500).send(`[proxy] too many parallel requests for "${req.url}"!`);
                this.adapter.log.warn(`[proxy] too many parallel requests for "${req.url}"`);
                return;
            }
            rule.request ||= [];
            rule.request.push({ req, res, ts: now });

            void handler(req as Parameters<typeof handler>[0], res as Parameters<typeof handler>[1], next);
        });
        // Subscribing `server.on('upgrade', handler.upgrade)` produces errors, so do NOT do it!
    }

    private installFileHandler(rule: ProxyRule): void {
        rule.url = rule.url.replace(/\\/g, '/');
        if (rule.url[0] !== '/' && !rule.url.match(/^[A-Za-z]:/)) {
            // Relative paths are relative to the node_modules directory (the code was in node_modules/iobroker.proxy/lib/).
            // The README says "relative to the ioBroker directory", but this is how it always worked.
            rule.url = normalize(`${__dirname}/../../../${rule.url}`);
        }

        this.app.use(`/${this.route}${rule.regex}`, (req, res, _next: NextFunction) => {
            let requestUrl = req.url;
            if (requestUrl === '/') {
                requestUrl = '';
            }
            let fileName = rule.url + requestUrl;
            const posQuestionMark = fileName.indexOf('?');
            const posHash = fileName.indexOf('#');
            if (posQuestionMark !== -1 || posHash !== -1) {
                const posCut = Math.min(
                    posQuestionMark === -1 ? fileName.length : posQuestionMark,
                    posHash === -1 ? fileName.length : posHash,
                );
                fileName = fileName.substring(0, posCut);
            }
            this.adapter.log.debug(
                `[proxy] File lookup for ${this.route}${rule.regex}: rule.req=${rule.url}, requestUrl=${requestUrl}, fileName=${fileName}`,
            );
            if (existsSync(fileName)) {
                const stat = statSync(fileName);
                if (stat.isDirectory()) {
                    const dirs = readdirSync(fileName);

                    let text = '';
                    dirs.sort();
                    for (const dir of dirs) {
                        text += `${text ? '<br>' : ''}<a href="./${dir}">${dir}</a>`;
                    }
                    res.set('Content-Type', 'text/html');
                    res.status(200).send(`<html><head><title>${fileName}</title></head><body>${text}</body>`);
                } else {
                    let data: Buffer;
                    try {
                        data = readFileSync(fileName);
                    } catch (e) {
                        res.status(500).send(`[proxy] Cannot read file: ${(e as Error).toString()}`);
                        return;
                    }
                    res.contentType(mime.getType(extname(fileName).substring(1)) || 'application/octet-stream');
                    res.status(200).send(data);
                }
            } else {
                res.status(404).send(`[proxy] File "${fileName}" not found.`);
                this.adapter.log.debug(`[proxy] File "${fileName}" not found.`);
            }
        });
    }

    public destroy(): void {
        if (this.interval) {
            this.adapter.clearInterval(this.interval);
            this.interval = null;
        }
    }

    /** Called by the web adapter, when it unloads its extensions */
    public unload(): Promise<void> {
        this.destroy();
        return Promise.resolve();
    }
}

// `module.exports = ProxyExtension` like before, so that every web version can load it (older ones know no `.default`)
export = ProxyExtension;
