#!/usr/bin/env node
/**
 * stage.js — copy the runtible extension files into dist/staging/.
 *
 * Shared by build-zxp.js (which signs the staged tree into a .zxp) and the
 * Windows installer build (which points Inno Setup at the staged tree
 * directly). Keeping this in one place means both packaging paths always
 * ship the exact same file list.
 *
 * Usage: node scripts/stage.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STAGING = path.join(DIST, "staging");

// Runtime files that belong in the shipped extension (everything else is dev).
const INCLUDE = ["CSXS", "css", "js", "jsx", "fonts", "index.html", "README.md", "CHANGELOG.md", "VERSION"];

function stage() {
    fs.rmSync(STAGING, { recursive: true, force: true });
    fs.mkdirSync(STAGING, { recursive: true });
    for (const entry of INCLUDE) {
        const src = path.join(ROOT, entry);
        if (!fs.existsSync(src)) {
            console.warn(`stage: skipping missing ${entry}`);
            continue;
        }
        fs.cpSync(src, path.join(STAGING, entry), { recursive: true });
    }
    return STAGING;
}

if (require.main === module) {
    const out = stage();
    console.log(`stage: staged runtime files at ${path.relative(ROOT, out)}`);
}

module.exports = { stage, ROOT, DIST, STAGING, INCLUDE };
