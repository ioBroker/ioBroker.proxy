// Augments the globally declared ioBroker types with everything this adapter adds.
// Keep in sync with `native` in io-package.json and with admin/jsonConfig.json.
declare global {
    namespace ioBroker {
        interface ProxyRuleConfig {
            /** Context below the route, e.g. "cam/" or "file.jpg" */
            regex: string;
            /** Target: "http(s)://[user:pass@]host[:port]", an absolute path or a path relative to node_modules */
            url: string;
            /** Timeout of this rule in ms, empty or 0 = `errorTimeout` */
            timeout?: number | string;
            /** Maximum number of parallel requests of this rule, empty or 0 = `parallelRequests` */
            parallelRequests?: number | string;
        }

        interface AdapterConfig {
            /** Route below the web adapter, "" = "proxy.<instance>/" */
            route: string;
            /** Web instance ("web.0" or "*" for all) that loads this extension */
            webInstance: string;
            /** Minimal interval in ms between retries after an error, also the default timeout of a rule */
            errorTimeout: number | string;
            /** Use the simple proxy (no web sockets, no POST bodies). Old configurations may hold the string "true" */
            simpleProxy: boolean | 'true' | 'false';
            /** Default of the maximum number of parallel requests per rule */
            parallelRequests: number | string;
            rules: ProxyRuleConfig[];
        }
    }
}

export {};
