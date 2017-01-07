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
    var that       = this;
    var proxy      = require('http-proxy-middleware');//require('express-http-proxy');

    this.config.route = this.config.route || (that.namespace + '/');
    function oneRule(rule) {
        adapter.log.info('Install extension on /' + that.config.route + rule.regex);
        var options = {
            target:         rule.url,
            ws:             true,
            secure:         false,
            changeOrigin:   false,
            xfwd:           true,
            onError: function (err) {
                adapter.log.error('Cannot get "' + rule.url + '": ' + err);
            },
            onProxyReq: function (req, origReq, res, options) {
                adapter.log.debug(req.method + ': ' + rule.url + req.path);
            },
            onProxyRes: function (req, reqOrig, res) {
                adapter.log.debug('Response for ' + reqOrig.url + ': ' + req.statusCode + '(' + req.statusMessage + ')');
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
            options.auth = m[1];
        }

        options.pathRewrite['^/' + that.config.route + rule.regex] = '/';

        rule.handler = proxy(options);
        that.app.use('/' + that.config.route + rule.regex, function (req, res, next) {
            rule.handler(req, res, next);
        });
    }

    var __construct = (function () {
        for (var e = 0; e < this.config.rules.length; e++) {
            oneRule(this.config.rules[e]);
        }
    }.bind(this))();
}

module.exports = Proxy;