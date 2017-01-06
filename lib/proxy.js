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

    var proxy      = require('express-http-proxy');

    var __construct = (function () {
        for (var e = 0; e < this.config.rules.length; e++) {
            adapter.log.info('Install extension on /' + this.namespace + '/' + this.config.rules[e].regex);
            this.app.use('/' + this.namespace + '/' + this.config.rules[e].regex, proxy(this.config.rules[e].url));
        }
    }.bind(this))();
}

module.exports = Proxy;