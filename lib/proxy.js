/* jshint -W097 */// jshint strict:false
/*jslint node: true */
/*jshint -W061 */
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
    var that       = this;
    var proxy;
    var path;
    var fs;

    this.config.errorTimeout = parseInt(this.config.errorTimeout, 10) || 10000;
    if (this.config.errorTimeout < 1000) this.config.errorTimeout = 1000;

    this.config.route = this.config.route || (that.namespace + '/');
    // remove leading slash
    if (this.config.route[0] === '/') {
        this.config.route = this.config.route.substr(1);
    }

    var mime = require('mime');

    this.interval = setInterval(function () {
        var now = Date.now();
        for (var e = 0; e < that.config.rules.length; e++) {
            var rule = that.config.rules[e];
            if (!rule.request) continue;

            for (var u = rule.request.length - 1; u >= 0; u--) {
                if (rule.request[u].res.finished) {
                    rule.request.splice(u, 1);
                } else
                if (now - rule.request[u].ts > rule.timeout) {
                    rule.lastError     = new Date().getTime();
                    rule.lastErrorText = 'timeout';

                    adapter.log.error('[proxy] Cannot get "' + rule.request[u].req.url + '": timeout');
                    rule.request.splice(u, 1);
                }
            }
        }
    }, 10000);

    function finishReq(rule, req, res) {
        if (rule.request) {
            var entry = rule.request.find(function (e) {
                return e.res === res;
            });
            if (!entry) {
                adapter.log.error('Request "' + req.url + '" not found in requests');
            } else {
                var ppos = rule.request.indexOf(entry);
                rule.request.splice(ppos, 1);
            }
        } else {
            adapter.log.error('URL "' + url + '" not found in requests');
        }
    }

    function oneRule(rule) {
        adapter.log.info('Install extension on /' + that.config.route + rule.regex);

        rule.timeout = parseInt(rule.timeout, 10) || that.config.errorTimeout;

        if (rule.url.match(/^https?:\/\//)) {
            proxy       = proxy || require('http-proxy-middleware');
            var options = {
                target:         rule.url,
                ws:             true,
                secure:         false,
                changeOrigin:   false,
                proxyTimeout:   rule.timeout,
                xfwd:           true,
                onError: function (err, req, res/* , url*/) {
                    rule.lastError     = new Date().getTime();
                    rule.lastErrorText = err.toString();

                    adapter.log.error('[proxy] Cannot get "' + rule.url + '": ' + err);
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
                onProxyReq: function (req /* , origReq, res, options */) {
                    adapter.log.debug(req.method + ': ' + rule.url + req.path);
                },
                onProxyRes: function (req, reqOrig, res) {
                    finishReq(rule, reqOrig, res);
                    rule.lastError = 0;
                    rule.lastErrorText = '';
                    adapter.log.debug('[proxy] Response for ' + reqOrig.url + ': ' + req.statusCode + '(' + req.statusMessage + ')');
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
            var m = rule.url.match(/^https?:\/\/(.+)@/);
            if (m && m[1] && m[1].indexOf(':') !== -1) {
                rule.url = rule.url.replace(m[1] + '@', '');
                options.auth = decodeURIComponent(m[1]);
            }

            options.pathRewrite['^/' + that.config.route + rule.regex] = '/';

            rule.handler = proxy(options);
            that.app.use('/' + that.config.route + rule.regex, function (req, res, next) {
                var now = Date.now();
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
            }.bind(this));
        } else {
            path = path || require('path');
            fs   = fs   || require('fs');
            rule.url = rule.url.replace(/\\/g, '/');
            if (rule.url[0] !== '/' && !rule.url.match(/^[A-Za-z]:/)) {
                rule.url = path.normalize(__dirname + '/../../' + rule.url);
            }
            // file handler
            that.app.use('/' + that.config.route + rule.regex, function (req, res, next) {
                var fileName = rule.url + req.url;
                if (fs.existsSync(fileName)) {
                    var stat = fs.statSync(fileName);
                    if (stat.isDirectory()) {
                        var dirs = fs.readdirSync(fileName);

                        var text = '';
                        dirs.sort();
                        for (var d = 0; d < dirs.length; d++) {
                            text += (text ? '<br>' : '') + '<a href="./' + dirs[d] + '">' + dirs[d] + '</a>';
                        }
                        res.set('Content-Type', 'text/html');
                        res.status(200).send('<html><head><title>' + fileName + '</title></head><body>' + text + '</body>');
                    } else {
                        var data;
                        try {
                            data = fs.readFileSync(fileName);
                        } catch (e) {
                            res.status(500).send('[proxy] Cannot read file: ' + e);
                            return;
                        }
                        res.contentType(mime.lookup(path.extname(fileName).substring(1)));
                        res.status(200).send(data);
                    }
                } else {
                    res.status(404).send('[proxy] File "' + fileName +'" not found.');
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

    var __construct = (function () {
        for (var e = 0; e < this.config.rules.length; e++) {
            oneRule(this.config.rules[e]);
        }
    }.bind(this))();
}

module.exports = Proxy;
