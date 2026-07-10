#!/usr/bin/env node
/**
 * build-zxp.js — package the extension into a signed ZXP.
 *
 * Produces dist/Syncitol-<version>.zxp so users can install via an extension
 * manager (e.g. Anastasiy's Extension Manager / ZXPInstaller) instead of
 * enabling PlayerDebugMode and hand-copying the folder.
 *
 * Requirements:
 *   - Adobe's ZXPSignCmd on PATH, or its path in $ZXPSIGNCMD.
 *     https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
 *   - A signing certificate. If none exists a self-signed one is generated at
 *     certs/selfsign.p12 (password from $ZXP_CERT_PASSWORD, default below).
 *
 * Usage: node scripts/build-zxp.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { stage, ROOT, DIST, STAGING } = require("./stage");

const CERTS = path.join(ROOT, "certs");
const CERT = path.join(CERTS, "selfsign.p12");
const CERT_PASSWORD = process.env.ZXP_CERT_PASSWORD || "syncitol";
const SIGNCMD = process.env.ZXPSIGNCMD || "ZXPSignCmd";

function fail(msg) {
    console.error("build-zxp: " + msg);
    process.exit(1);
}

function run(args) {
    const res = spawnSync(SIGNCMD, args, { stdio: "inherit" });
    if (res.error && res.error.code === "ENOENT") {
        fail(`ZXPSignCmd not found. Install it and put it on PATH or set $ZXPSIGNCMD.\n` +
            `  See https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD`);
    }
    if (res.status !== 0) fail(`ZXPSignCmd exited with code ${res.status}.`);
}

function version() {
    return fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
}

function ensureCert() {
    if (fs.existsSync(CERT)) return;
    fs.mkdirSync(CERTS, { recursive: true });
    console.log("build-zxp: no certificate found — generating a self-signed one.");
    run(["-selfSignedCert", "US", "CA", "Syncitol", "Syncitol", CERT_PASSWORD, CERT]);
}

function main() {
    const v = version();
    fs.mkdirSync(DIST, { recursive: true });
    ensureCert();
    stage();

    const out = path.join(DIST, `Syncitol-${v}.zxp`);
    fs.rmSync(out, { force: true });
    run(["-sign", STAGING, out, CERT, CERT_PASSWORD]);

    fs.rmSync(STAGING, { recursive: true, force: true });
    console.log(`build-zxp: created ${path.relative(ROOT, out)}`);
}

main();
