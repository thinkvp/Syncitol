#!/usr/bin/env node
/**
 * check-syntax.js — zero-dependency syntax gate.
 *
 * Compiles every shipped/tooling script with the V8 parser (via node:vm) to
 * catch syntax errors without pulling in ESLint. ExtendScript files are ES3 and
 * still parse cleanly as scripts. This is intentionally lightweight; it does not
 * do style or semantic linting.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

const FILES = [
    "js/dsp.js",
    "js/main.js",
    "jsx/sync.jsx",
    "jsx/json2.js",
    "scripts/set-version.js",
    "scripts/build-zxp.js",
    "scripts/check-syntax.js",
    "tests/dsp.test.js",
];

let failed = 0;
for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
        console.error(`check-syntax: MISSING ${rel}`);
        failed += 1;
        continue;
    }
    try {
        // eslint-disable-next-line no-new
        new vm.Script(fs.readFileSync(file, "utf8"), { filename: rel });
        console.log(`check-syntax: ok ${rel}`);
    } catch (e) {
        console.error(`check-syntax: FAIL ${rel} — ${e.message}`);
        failed += 1;
    }
}

if (failed) {
    console.error(`check-syntax: ${failed} file(s) failed.`);
    process.exit(1);
}
console.log("check-syntax: all files parse.");
