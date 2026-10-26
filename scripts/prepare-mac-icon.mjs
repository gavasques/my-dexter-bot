#!/usr/bin/env node
// Encode caller-selected artwork into the macOS ICNS sizes. No image generation, app launch or install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const usage = "node scripts/prepare-mac-icon.mjs --source ABS/icon.png --out ABS/DexterAppIcon.icns";
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
let options;
try { options = parseArgs({ options: { source: { type: "string" }, out: { type: "string" } }, strict: true }).values; }
catch { fail(usage); }
if (process.platform !== "darwin") fail("ICNS encoding requires macOS sips and iconutil.");
for (const key of ["source", "out"]) {
  if (!options[key] || !path.isAbsolute(options[key]) || options[key].includes("\0")) fail(usage);
}
const source = options.source;
const out = options.out;
if (!lstatSync(source).isFile() || !source.endsWith(".png")) fail("Source must be a regular PNG file.");
if (existsSync(out) || !out.endsWith(".icns") || !lstatSync(path.dirname(out)).isDirectory()) fail("Output must be a new .icns file in an existing directory.");
const input = readFileSync(source);
if (input.length > 8 * 1024 * 1024 || !input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail("Source is not a bounded PNG.");
const width = input.readUInt32BE(16), height = input.readUInt32BE(20);
if (width !== height || width < 1024 || width > 4096) fail("Source must be square and at least 1024 pixels.");
const work = mkdtempSync(path.join(tmpdir(), "dexter-icon-"));
const iconset = path.join(work, "Dexter.iconset");
mkdirSync(iconset);
try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const file = path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
      execFileSync("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), source, "--out", file], { stdio: "pipe", timeout: 30_000 });
    }
  }
  const encoded = path.join(work, "Dexter.icns");
  execFileSync("/usr/bin/iconutil", ["--convert", "icns", "--output", encoded, iconset], { stdio: "pipe", timeout: 30_000 });
  const bytes = readFileSync(encoded);
  if (bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) throw new Error("Invalid ICNS");
  copyFileSync(encoded, out);
  const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
  process.stdout.write(JSON.stringify({ source, out, sourceSize: [width, height], generatedRepresentations: 10, sourceSHA256: hash(input), iconSHA256: hash(bytes) }, null, 2) + "\n");
} catch {
  process.stderr.write("ICNS preparation failed. No app or account was touched.\n");
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
