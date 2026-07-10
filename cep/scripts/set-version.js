#!/usr/bin/env node
/**
 * set-version.js — single-source the extension version.
 *
 * VERSION (repo root) is the canonical source of truth. This script stamps that
 * value into the places that must agree:
 *   - CSXS/manifest.xml  → ExtensionBundleVersion + the ExtensionList Version
 *   - index.html         → footer "Syncitol vX"
 *
 * Usage:
 *   node scripts/set-version.js            # stamp files from VERSION
 *   node scripts/set-version.js 1.2.3      # write VERSION then stamp
 *   node scripts/set-version.js --check    # verify files match VERSION (CI)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(ROOT, "VERSION");
const MANIFEST_FILE = path.join(ROOT, "CSXS", "manifest.xml");
const INDEX_FILE = path.join(ROOT, "index.html");
const PACKAGE_FILE = path.join(ROOT, "package.json");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const explicit = args.find(a => !a.startsWith("--"));

function readVersion() {
    if (explicit) {
        if (!/^\d+\.\d+\.\d+$/.test(explicit)) {
            fail(`Version "${explicit}" is not semver (X.Y.Z).`);
        }
        return explicit;
    }
    if (!fs.existsSync(VERSION_FILE)) fail("VERSION file not found.");
    const v = fs.readFileSync(VERSION_FILE, "utf8").trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) fail(`VERSION "${v}" is not semver (X.Y.Z).`);
    return v;
}

function fail(msg) {
    console.error("set-version: " + msg);
    process.exit(1);
}

/**
 * Apply each [regex, replacement] to the file. In --check mode, report mismatches
 * instead of writing. Returns the number of substitutions that would change content.
 */
function stamp(file, edits, label) {
    const original = fs.readFileSync(file, "utf8");
    let next = original;
    for (const [re, repl] of edits) {
        if (!re.test(next)) fail(`Pattern ${re} not found in ${label}.`);
        next = next.replace(re, repl);
    }
    if (next === original) return false;
    if (checkOnly) {
        console.error(`set-version: ${label} is out of date.`);
        return true;
    }
    fs.writeFileSync(file, next);
    console.log(`set-version: stamped ${label}`);
    return true;
}

function main() {
    const version = readVersion();
    let drift = false;

    drift = stamp(MANIFEST_FILE, [
        [/(ExtensionBundleVersion=")[^"]*(")/, `$1${version}$2`],
        [/(<Extension Id="com\.syncitol\.panel\.main" Version=")[^"]*(")/, `$1${version}$2`],
    ], "CSXS/manifest.xml") || drift;

    // Footer shows the marketing version (major.minor) — e.g. 1.0.1 → "v1.0".
    const marketing = version.split(".").slice(0, 2).join(".");
    drift = stamp(INDEX_FILE, [
        [/(<span>Syncitol v)[^<]*(<\/span>)/, `$1${marketing}$2`],
    ], "index.html") || drift;

    if (fs.existsSync(PACKAGE_FILE)) {
        drift = stamp(PACKAGE_FILE, [
            [/("version":\s*")[^"]*(")/, `$1${version}$2`],
        ], "package.json") || drift;
    }

    if (!checkOnly && explicit) {
        fs.writeFileSync(VERSION_FILE, version + "\n");
        console.log(`set-version: wrote VERSION = ${version}`);
    }

    if (checkOnly && drift) {
        fail("version drift detected — run `node scripts/set-version.js`.");
    }
    if (!drift) console.log(`set-version: all files already at ${version}`);
}

main();
