'use strict';

// Tests build/lib/proxy.js (run `npm run build` first)
const assert = require('node:assert');
const { createServer, get } = require('node:http');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const ProxyExtension = require('../build/lib/proxy');
const { maskUrl } = require('../build/lib/utils');

/** The web adapter as far as the extension uses it */
function createFakeAdapter() {
    const intervals = new Set();
    return {
        intervals,
        log: {
            error: () => {},
            warn: () => {},
            info: () => {},
            debug: () => {},
        },
        setInterval: (cb, ms) => {
            const timer = setInterval(cb, ms);
            intervals.add(timer);
            return timer;
        },
        clearInterval: timer => {
            clearInterval(timer);
            intervals.delete(timer);
        },
    };
}

/** Minimal express: `use(path, handler)` with prefix match and the response helpers used by the extension */
function createFakeApp() {
    const routes = [];
    const app = {
        use: (path, handler) => routes.push({ path, handler }),
        handle: (req, res) => {
            res.status = code => {
                res.statusCode = code;
                return res;
            };
            res.set = (key, value) => {
                res.setHeader(key, value);
                return res;
            };
            res.contentType = type => res.set('Content-Type', type);
            res.send = body => {
                if (body === undefined || body === null) {
                    body = '';
                } else if (typeof body === 'object' && !Buffer.isBuffer(body)) {
                    body = JSON.stringify(body);
                }
                if (!res.getHeader('Content-Type')) {
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                }
                res.end(body);
                return res;
            };
            const route = routes.find(r => req.url.startsWith(r.path));
            if (!route) {
                res.status(404).send('no route');
                return;
            }
            const originalUrl = req.url;
            req.url = req.url.substring(route.path.length);
            if (!req.url.startsWith('/')) {
                req.url = `/${req.url}`;
            }
            route.handler(req, res, () => {
                req.url = originalUrl;
                res.status(404).send('next');
            });
        },
    };
    return app;
}

function listen(handler) {
    return new Promise(resolve => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function close(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

function instance(native) {
    return { _id: 'system.adapter.proxy.0', common: {}, native };
}

describe('maskUrl', () => {
    it('should hide credentials and secret parameters', () => {
        assert.strictEqual(maskUrl('http://user:pass@cam/snap.jpg'), 'http://***@cam/snap.jpg');
        assert.strictEqual(maskUrl('/snap.cgi?user=admin&pwd=secret&x=1'), '/snap.cgi?user=***&pwd=***&x=1');
    });
});

describe('ProxyExtension', () => {
    let target;
    let targetUrl;
    let web;
    let webUrl;
    let adapter;
    let extension;
    let dir;
    const received = [];

    before(async () => {
        target = await listen((req, res) => {
            received.push({ url: req.url, method: req.method, headers: req.headers });
            if (req.url.startsWith('/missing')) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not here');
            } else if (req.url.startsWith('/redirect')) {
                res.writeHead(302, { Location: '/hello' });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Test': 'yes' });
                res.end(`hello ${req.url}`);
            }
        });
        targetUrl = `http://127.0.0.1:${target.address().port}`;

        dir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
        mkdirSync(join(dir, 'sub'));
        writeFileSync(join(dir, 'a.json'), '{"a":1}');
        writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
    });

    after(async () => {
        await close(target);
        rmSync(dir, { recursive: true, force: true });
    });

    afterEach(async () => {
        extension?.destroy();
        assert.strictEqual(adapter.intervals.size, 0);
        if (web) {
            web.closeAllConnections();
            await close(web);
            web = null;
        }
        received.length = 0;
    });

    async function start(native) {
        adapter = createFakeAdapter();
        const app = createFakeApp();
        extension = new ProxyExtension(null, {}, adapter, instance(native), app);
        web = await listen((req, res) => app.handle(req, res));
        webUrl = `http://127.0.0.1:${web.address().port}`;
    }

    describe('files', () => {
        it('should deliver files with mime type and list directories', async () => {
            await start({ route: '', rules: [{ regex: 'dir/', url: `${dir}/` }] });

            let res = await fetch(`${webUrl}/proxy.0/dir/a.json?x=1#y`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('content-type'), 'application/json');
            assert.strictEqual(await res.text(), '{"a":1}');

            res = await fetch(`${webUrl}/proxy.0/dir/`);
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('<a href="./a.json">a.json</a><br><a href="./sub">sub</a>'));

            res = await fetch(`${webUrl}/proxy.0/dir/nothing.txt`);
            assert.strictEqual(res.status, 404);
        });

        it('should not deliver files outside of the configured directory', async () => {
            await start({ rules: [{ regex: 'dir/', url: `${join(dir, 'sub')}/` }] });
            // fetch() and URL strings would normalize "..", so send the path as is
            const status = await new Promise((resolve, reject) =>
                get({ host: '127.0.0.1', port: web.address().port, path: '/proxy.0/dir/../a.json' }, res => {
                    res.resume();
                    resolve(res.statusCode);
                }).on('error', reject),
            );
            assert.strictEqual(status, 403);
            const res = await fetch(`${webUrl}/proxy.0/dir/b.txt`);
            assert.strictEqual(await res.text(), 'b');
        });

        it('should deliver a single file and use the route without leading slash', async () => {
            await start({ route: '/files/', rules: [{ regex: 'b.txt', url: join(dir, 'sub', 'b.txt') }] });
            const res = await fetch(`${webUrl}/files/b.txt`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('content-type'), 'text/plain');
            assert.strictEqual(await res.text(), 'b');
        });
    });

    describe('simple proxy', () => {
        it('should forward GET requests with headers and status', async () => {
            await start({ simpleProxy: 'true', errorTimeout: '1000', rules: [{ regex: 'cam/', url: targetUrl }] });
            // the simple proxy needs no interval
            assert.strictEqual(adapter.intervals.size, 0);

            const res = await fetch(`${webUrl}/proxy.0/cam/snap.jpg?a=1`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('x-test'), 'yes');
            assert.strictEqual(await res.text(), 'hello /snap.jpg?a=1');
            assert.strictEqual(received[0].url, '/snap.jpg?a=1');
            // the headers of the client are forwarded
            assert.strictEqual(received[0].headers['accept-encoding'], 'gzip, deflate');
        });

        it('should not request compression, if the client did not ask for it', async () => {
            await start({ simpleProxy: true, rules: [{ regex: 'cam/', url: targetUrl }] });
            await new Promise((resolve, reject) =>
                get(`${webUrl}/proxy.0/cam/x`, res => res.resume().on('end', resolve)).on('error', reject),
            );
            assert.strictEqual(received[0].headers['accept-encoding'], undefined);
        });

        it('should send decoded credentials from the URL as basic auth', async () => {
            const url = targetUrl.replace('http://', 'http://us%40er:p%3Ass:w@');
            await start({ simpleProxy: true, rules: [{ regex: 'cam/', url }] });
            await fetch(`${webUrl}/proxy.0/cam/x`);
            assert.strictEqual(
                received[0].headers.authorization,
                `Basic ${Buffer.from('us@er:p:ss:w').toString('base64')}`,
            );
        });

        it('should follow redirects for GET', async () => {
            await start({ simpleProxy: true, rules: [{ regex: 'cam/', url: targetUrl }] });
            const res = await fetch(`${webUrl}/proxy.0/cam/redirect`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(await res.text(), 'hello /hello');
        });

        it('should not follow redirects for POST', async () => {
            await start({ simpleProxy: true, rules: [{ regex: 'cam/', url: targetUrl }] });
            const res = await fetch(`${webUrl}/proxy.0/cam/redirect`, { method: 'POST' });
            assert.strictEqual(res.status, 302);
        });

        it('should block the rule after an error for errorTimeout', async () => {
            await start({ simpleProxy: true, errorTimeout: 1000, rules: [{ regex: 'cam/', url: targetUrl }] });
            let res = await fetch(`${webUrl}/proxy.0/cam/missing`);
            assert.strictEqual(res.status, 404);
            assert.strictEqual(await res.text(), 'not here');

            res = await fetch(`${webUrl}/proxy.0/cam/ok`);
            assert.strictEqual(res.status, 404);
            assert.strictEqual(await res.text(), '[proxy] Cannot read file: not here');
            assert.strictEqual(received.length, 1);
        });

        it('should answer 500 if the target is not reachable', async () => {
            await start({ simpleProxy: true, rules: [{ regex: 'cam/', url: 'http://127.0.0.1:1' }] });
            const res = await fetch(`${webUrl}/proxy.0/cam/x`);
            assert.strictEqual(res.status, 500);
        });
    });

    describe('http-proxy-middleware', () => {
        it('should stop the interval, when web unloads the extension', async () => {
            await start({ rules: [{ regex: 'cam/', url: targetUrl }] });
            assert.strictEqual(adapter.intervals.size, 1);
            await extension.unload();
            assert.strictEqual(adapter.intervals.size, 0);
        });

        it('should forward requests and remove the route from the path', async () => {
            await start({ rules: [{ regex: 'cam/', url: targetUrl }] });
            assert.strictEqual(adapter.intervals.size, 1);

            const res = await fetch(`${webUrl}/proxy.0/cam/snap.jpg?a=1`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(await res.text(), 'hello /snap.jpg?a=1');
        });

        it('should send credentials from the URL as basic auth', async () => {
            const url = targetUrl.replace('http://', 'http://user:pa%40ss@');
            await start({ rules: [{ regex: 'cam/', url }] });
            await fetch(`${webUrl}/proxy.0/cam/x`);
            assert.strictEqual(
                received[0].headers.authorization,
                `Basic ${Buffer.from('user:pa@ss').toString('base64')}`,
            );
        });

        it('should answer 500 on errors and block the rule afterwards', async () => {
            await start({ rules: [{ regex: 'cam/', url: 'http://127.0.0.1:1' }] });
            let res = await fetch(`${webUrl}/proxy.0/cam/x`);
            assert.strictEqual(res.status, 500);
            res = await fetch(`${webUrl}/proxy.0/cam/x`);
            assert.strictEqual(res.status, 404);
            assert.ok((await res.text()).startsWith('[proxy] Cannot read file: Error: connect'));
        });
    });
});
