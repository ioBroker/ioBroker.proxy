'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');

// The adapter is a pure web extension (common.mode: "extension"): it is never started as an own process,
// but loaded by the web adapter. Started directly, build/lib/proxy.js only defines the class and exits with 0.
// The proxy logic itself is tested in test/unitProxy.js.
tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [0],
});
