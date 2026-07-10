#!/usr/bin/env node
/**
 * check-syntax.js — zero-dependency syntax gate.
 * Compiles each JS file with the V8 parser (node:vm) to catch syntax errors
 * without executing (so require("premierepro"), document, etc. are fine here).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const FILES = [
    "js/dsp.js",
    "js/audio.js",
    "js/pek.js",
    "js/premiere.js",
    "js/main.js",
    "tests/dsp.test.js",
    "scripts/check-syntax.js",
];

let failed = 0;
for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { console.error(`check-syntax: MISSING ${rel}`); failed++; continue; }
    try {
        new vm.Script(fs.readFileSync(file, "utf8"), { filename: rel });
        console.log(`check-syntax: ok ${rel}`);
    } catch (e) {
        console.error(`check-syntax: FAIL ${rel} — ${e.message}`);
        failed++;
    }
}
if (failed) { console.error(`check-syntax: ${failed} file(s) failed.`); process.exit(1); }
console.log("check-syntax: all files parse.");
