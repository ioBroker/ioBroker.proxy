/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
/* jshint -W061 */
'use strict';

/**
 * Proxy class
 *
 * From settings used only secure, auth and crossDomain
 *
 * @class
 * @param {object} server http or https node.js object
 * @param {object} webSettings settings of the web server, like <pre><code>{secure: settings.secure, port: settings.port}</code></pre>
 * @param {object} adapter web adapter object
 * @param {object} instanceSettings instance object with common and native
 * @param {object} app express application
 * @return {object} object instance
 */
function Proxy(server, webSettings, adapter, instanceSettings, app) {
    if (!(this instanceof Proxy)) return new Proxy(server, webSettings, adapter, instanceSettings, app);

    this.app       = app;
    this.adapter   = adapter;
    this.settings  = webSettings;
    this.config    = instanceSettings ? instanceSettings.native : {};
    this.namespace = instanceSettings ? instanceSettings._id.substring('system.adapter.'.length) : 'simple-api';
    this.request   = {};
    this.simpleProxy = this.config.simpleProxy === true || this.config.simpleProxy === 'true';
    const that       = this;
    let proxy;
    let request;
    let path;
    let fs;
    let mime;

    this.config.errorTimeout = parseInt(this.config.errorTimeout, 10) || 10000;
    if (this.config.errorTimeout < 1000) {
        this.config.errorTimeout = 1000;
    }

    this.config.route = this.config.route || (this.namespace + '/');
    // remove leading slash
    if (this.config.route[0] === '/') {
        this.config.route = this.config.route.substr(1);
    }

    if (!this.simpleProxy) {
        this.interval = setInterval(() => {
            const now = Date.now();
            for (let e = 0; e < this.config.rules.length; e++) {
                const rule = this.config.rules[e];
                if (!rule.request) continue;

                for (let u = rule.request.length - 1; u >= 0; u--) {
                    if (rule.request[u].res.finished) {
                        rule.request.splice(u, 1);
                    } else
                    if (now - rule.request[u].ts > rule.timeout) {
                        rule.lastError     = Date.now();
                        rule.lastErrorText = 'timeout';

                        adapter.log.error('[proxy] Cannot ' + rule.request[u].req.method + ' "' + rule.request[u].req.url + '": timeout');
                        rule.request.splice(u, 1);
                    }
                }
            }
        }, 10000);
    }

    function finishReq(rule, req, res) {
        if (rule.request) {
            const entry = rule.request.find(e => e.res === res);
            if (!entry) {
                adapter.log.error('Request ' + req.method + ' "' + req.url + '" not found in requests');
            } else {
                const ppos = rule.request.indexOf(entry);
                rule.request.splice(ppos, 1);
            }
        } else {
            adapter.log.error('Request ' + req.method + ' "' + req.url + '" not found in requests');
        }
    }

    function oneRule(rule) {
        adapter.log.info('Install extension on /' + that.config.route + rule.regex);

        rule.timeout = parseInt(rule.timeout, 10) || that.config.errorTimeout;

        if (rule.url.match(/^https?:\/\//)) {
            if (that.simpleProxy) {
                request       = request || require('request');
                that.app.use('/' + that.config.route + rule.regex, (req, res) => {
                    const now = Date.now();
                    if (rule.lastError && ((now - rule.lastError) < that.config.errorTimeout)) {
                        res.status(rule.lastStatusCode).send('[proxy] Cannot read file: ' + rule.lastErrorText);
                        return
                    }

                    request({
                        url: rule.url + req.url,
                        encoding: null,
                        headers: req.headers,
                        timeout: rule.timeout,
                        method: req.method
                    }, (error, state, body) => {
                        if (error || !state || state.statusCode !== 200) {
                            rule.lastError     = Date.now();
                            rule.lastErrorText = (error || body).toString();
                            rule.lastStatusCode = state ? state.statusCode || 500 : 500;
                            res.status(rule.lastStatusCode).send(rule.lastErrorText);
                        } else {
                            rule.lastError = 0;
                            rule.lastErrorText = '';
                            rule.lastStatusCode = 200;
                            Object.keys(state.headers).forEach(key => res.set(key, state.headers[key]));
                            res.send(body || '');
                        }
                    });
                });
            } else {
                proxy       = proxy || require('http-proxy-middleware').createProxyMiddleware;
                const options = {
                    target:         rule.url,
                    ws:             true,
                    secure:         false,
                    changeOrigin:   false,
                    proxyTimeout:   rule.timeout,
                    xfwd:           true,
                    onError: (err, req, res/* , url*/) => {
                        rule.lastError     = Date.now();
                        rule.lastErrorText = err.toString();

                        adapter.log.error('[proxy] Proxy error "' + rule.url + '": ' + err);
                        if (!res.finished) {
                            try {
                                if (typeof res.status === 'function') {
                                    res.status(500).send(err);
                                } else if (typeof res.send === 'function') {
                                    res.send(err);
                                } else {
                                    adapter.log.error('[proxy] Cannot response');
                                }
                            } catch (e) {
                                adapter.log.error('[proxy] Cannot response: ' + e);
                            }
                        }

                        finishReq(rule, req, res);
                    },
                    onProxyReq: (req /* , origReq, res, options */) => adapter.log.debug(req.method + ': ' + rule.url + req.path),
                    onProxyRes: (req, reqOrig, res) => {
                        finishReq(rule, reqOrig, res);
                        rule.lastError = 0;
                        rule.lastErrorText = '';
                        adapter.log.debug('[proxy] Response for ' + reqOrig.url + ': ' + req.statusCode + '(' + req.statusMessage + ')');
                    },
                    onOpen: (socket) => {
                        socket && socket.on('error', err => {
                            adapter.log.info('[proxy] Socket Error for ' + reqOrig.url + ': ' + err);
                        });
                    },
                    /*onProxyReqWs: function () {
                     console.log('onProxyReqWs');
                     },

                     onOpen: function () {
                     console.log('onOpen');
                     },
                    onClose: function () {
                        console.log('onClose');
                    },*/
                    pathRewrite: {}
                };
                const m = rule.url.match(/^https?:\/\/(.+)@/);
                if (m && m[1] && m[1].indexOf(':') !== -1) {
                    rule.url = rule.url.replace(m[1] + '@', '');
                    options.auth = decodeURIComponent(m[1]);
                    options.target = rule.url;
                }

                options.pathRewrite['^/' + that.config.route + rule.regex] = '/';

                adapter.log.info(JSON.stringify(options));

                rule.handler = proxy(options);
                that.app.use('/' + that.config.route + rule.regex, (req, res, next) => {
                    const now = Date.now();
                    if (rule.lastError && ((now - rule.lastError) < that.config.errorTimeout)) {
                        res.status(404).send('[proxy] Cannot read file: ' + rule.lastErrorText);
                        return
                    }

                    if (rule.request && rule.request.length > 10) {
                        res.status(500).send('[proxy] too many parallel requests for "' + req.url + '"!');
                        adapter.log.warn('[proxy] too many parallel requests for "' + req.url + '"');
                        return;
                    }
                    rule.request = rule.request || [];
                    rule.request.push({req: req, res: res, ts: now});

                    rule.handler(req, res, next);
                });
            }
        } else {
            path = path || require('path');
            fs   = fs   || require('fs');
            mime = mime || require('mime');
            rule.url = rule.url.replace(/\\/g, '/');
            if (rule.url[0] !== '/' && !rule.url.match(/^[A-Za-z]:/)) {
                rule.url = path.normalize(__dirname + '/../../' + rule.url);
            }
            // file handler
            that.app.use('/' + that.config.route + rule.regex, (req, res, _next) => {
                let fileName = rule.url + req.url;
                const posQuestionmark = fileName.indexOf('?');
                const posHash = fileName.indexOf('#');
                if (posQuestionmark !== -1 || posHash !== -1) {
                    let posCut = Math.min(posQuestionmark === -1 ? fileName.length : posQuestionmark, posHash === -1 ? fileName.length : posHash);
                    fileName = fileName.substring(0, posCut);
                }
                adapter.log.debug('[proxy] File lookup for ' + that.config.route + rule.regex + ': rule.req=' + rule.url + ', req.url=' + req.url + ', fileName=' + fileName);
                if (fs.existsSync(fileName)) {
                    const stat = fs.statSync(fileName);
                    if (stat.isDirectory()) {
                        const dirs = fs.readdirSync(fileName);

                        let text = '';
                        dirs.sort();
                        for (let d = 0; d < dirs.length; d++) {
                            text += (text ? '<br>' : '') + '<a href="./' + dirs[d] + '">' + dirs[d] + '</a>';
                        }
                        res.set('Content-Type', 'text/html');
                        res.status(200).send('<html><head><title>' + fileName + '</title></head><body>' + text + '</body>');
                    } else {
                        let data;
                        try {
                            data = fs.readFileSync(fileName);
                        } catch (e) {
                            res.status(500).send('[proxy] Cannot read file: ' + e);
                            return;
                        }
                        res.contentType(mime.getType(path.extname(fileName).substring(1)) || 'application/octet-stream');
                        res.status(200).send(data);
                    }
                } else {
                    res.status(404).send('[proxy] File "' + fileName +'" not found.');
                    adapter.log.debug('[proxy] File "' + fileName +'" not found.');
                }
            });
        }
    }

    this.destroy = function () {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    };

    const __construct = (function () {
        for (let e = 0; e < this.config.rules.length; e++) {
            oneRule(this.config.rules[e]);
        }
    }.bind(this))();
}

module.exports = Proxy;
