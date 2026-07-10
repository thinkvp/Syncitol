#!/usr/bin/env node
/**
 * build-ccx.js — package the plugin as a minimal .ccx (a zip Creative Cloud
 * installs on double-click).
 *
 * Stages ONLY what the plugin needs at runtime:
 *   manifest.json, index.html (dev-harness script tag stripped),
 *   js/{dsp,audio,pek,premiere,main}.js, css/, fonts/, win/x64/syncitol.uxpaddon
 * Explicitly NOT staged: js/selftest.js, tests/, scripts/, node_modules/,
 * debug-*.json, docs — a previous package accidentally bundled a full shared
 * FFmpeg build and ballooned to 320 MB; this stays ~2.5 MB.
 *
 * Zero npm dependencies: staging via fs, zipping via PowerShell (Windows).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;

const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "stage");
const OUT = path.join(DIST, `Syncitol-UXP-${version}.ccx`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

function copy(rel) {
    const src = path.join(ROOT, rel);
    const dst = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

// Manifest + plugin code.
copy("manifest.json");
for (const f of ["dsp.js", "audio.js", "pek.js", "premiere.js", "main.js"]) copy(`js/${f}`);

// index.html with the dev harness stripped.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/\s*<script src="js\/selftest\.js"><\/script>/, "");
fs.writeFileSync(path.join(STAGE, "index.html"), html);

// Styles + bundled fonts.
copy("css/style.css");
for (const f of fs.readdirSync(path.join(ROOT, "fonts"))) copy(`fonts/${f}`);

// The native addon — the whole FFmpeg story in 2.3 MB.
copy("win/x64/syncitol.uxpaddon");

// Zip the STAGE CONTENTS (manifest.json at archive root) → .ccx. Entry names
// use forward slashes per the zip spec (Compress-Archive writes backslashes,
// which breaks extraction on non-Windows tooling), so drive System.IO directly.
fs.rmSync(OUT, { force: true });
execFileSync("powershell", [
    "-NoProfile", "-Command",
    `Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; ` +
    `$zip = [System.IO.Compression.ZipFile]::Open("${OUT}", [System.IO.Compression.ZipArchiveMode]::Create); ` +
    `Get-ChildItem -Path "${STAGE}" -Recurse -File | ForEach-Object { ` +
    `  $rel = $_.FullName.Substring("${STAGE}".Length + 1).Replace('\\', '/'); ` +
    `  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) ` +
    `}; $zip.Dispose()`
], { stdio: "inherit" });
fs.rmSync(STAGE, { recursive: true, force: true });

const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
console.log(`build-ccx: ${path.relative(ROOT, OUT)} (${mb} MB)`);
if (fs.statSync(OUT).size > 10 * 1024 * 1024) {
    console.error("build-ccx: package is unexpectedly large — check the staged contents.");
    process.exit(1);
}
