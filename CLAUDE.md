# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ioBroker adapter `proxy` (npm `iobroker.proxy`, TypeScript in `src/`, compiled to `build/`). It is a pure **web extension** (`common.mode: "extension"`): there is no own process and no `main.ts`. The web adapter instance named in `native.webInstance` (or `*` for all) loads `common.webExtension` = `build/lib/proxy.js` and calls `new ProxyExtension(server, webSettings, webAdapter, proxyInstanceObject, expressApp)`. The extension mounts one express route per rule below `/<native.route>` (default `proxy.<instance>/`) and forwards to HTTP(S) targets or serves local files. Node >= 22.19, js-controller >= 6.0.11, admin >= 7.0.0, web >= 1.5.4.

## Commands

```bash
npm run build          # tsc -p tsconfig.build.json -> build/ (gitignored, common.nogit: true)
npm run check          # type-check only
npm run lint           # @iobroker/eslint-config incl. prettier; fix with: npx eslint -c eslint.config.mjs --fix src
npm test               # test:package + test:unit
npm run test:unit      # mocha test/unitProxy - runs against build/, so build first
npm run translate      # translate-adapter -b admin/i18n/en.json
npm run release-minor  # @alcalzone/release-script (README changelog, io-package news, LICENSE year)
```

Single test: `npx mocha test/unitProxy --exit -g "simple proxy"`. Tests use `node:assert`, no chai. `test/unitProxy.js` uses a tiny fake express app (`use` with prefix match, `status`/`send`/`set`/`contentType`) and a fake web adapter, plus real local HTTP servers as targets. There is no integration test: an extension-only adapter cannot be started by the testing harness. No `prepare` script on purpose: `npm ci` does not build, CI builds via `build: true` in the ioBroker GitHub actions.

## Architecture

- `src/lib/proxy.ts` - `ProxyExtension`, exported with `export =` (= `module.exports`), so old web versions that don't unwrap `.default` can load it. Per rule, depending on the target:
  - `http(s)://` + `simpleProxy` -> `simpleRequest()` with axios: fetches the whole answer, forwards status 200 with all headers, otherwise sends the error and blocks the rule for `errorTimeout` with the last status code. The request body is not forwarded. It reproduces the former `request` library: no automatic `Accept-Encoding` (`false` suppresses the axios default), `decompress: false`, credentials from the URL percent-decoded and only if the client sent no `Authorization`, redirects followed manually (max 10, not for PATCH/PUT/POST/DELETE, host header dropped, credentials dropped on host change) because follow-redirects would resolve relative locations against the forwarded `Host` header of web.
  - `http(s)://` otherwise -> `http-proxy-middleware` v2 (with web sockets). `user:pass@` is moved to `options.auth`, the route is removed via `pathRewrite`. Pending requests are tracked per rule in `rule.request`; `checkTimeouts()` (every 10 s, via `adapter.setInterval` of the *web* adapter) drops finished/timed-out ones. Errors block the rule for `errorTimeout` (answer 404), more than `parallelRequests` pending requests are answered with 500.
  - anything else -> local file or directory (directory listing as HTML). Relative paths are resolved against `node_modules/` (the original `__dirname/../../` of `lib/proxy.js`; now `build/lib/../../../`) - the README claims the ioBroker directory, but that is how it always worked.
- `src/lib/utils.ts` - `maskUrl()` (never log credentials), `toInt()` (the old admin stored numbers as strings).
- `src/lib/types.ts` - minimal express request/response/app interfaces and the runtime `ProxyRule` (config + `request`, `lastError*`, `handler`). The config objects themselves are not mutated.
- `adapter` passed to the extension is the **web** adapter, `instanceSettings` is this proxy instance.

Adding a config option: `io-package.json` `native` (default), `src/lib/adapter-config.d.ts`, `admin/jsonConfig.json`, and the label in all 10 `admin/i18n/<lang>.json` files - keep the key sets identical, otherwise saving the config drops values. `native.route` = `""` means `proxy.<instance>/` (the old admin stored the default as empty string).

## Conventions

- Behavior of the proxy must stay compatible: rule fields (`regex`, `url`, `timeout`, `parallelRequests`), status codes and error texts are relied on by existing installations.
- Don't edit `common.news` or the version by hand; add changelog lines under `### **WORK IN PROGRESS**` in README.md.
- `@types/express` (v4) is only needed because the typings of http-proxy-middleware v2 import it.
