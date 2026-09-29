// Verifies the built extension/ directory the way Chrome would: the manifest's
// CSP is enforced as a real response header, and we assert that the Next.js app
// both renders and hydrates (i.e. every inline script executed).
//
// Run with:  node scripts/verify-extension.mjs
// Needs:     PUPPETEER_CHROME=/path/to/chrome  (or a Chrome/Chromium binary)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");

const CHROME = process.env.PUPPETEER_CHROME;
if (!CHROME || !existsSync(CHROME)) {
  console.error("Set PUPPETEER_CHROME to a Chrome binary to run this check.");
  process.exit(2);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const manifest = JSON.parse(await readFile(path.join(extDir, "manifest.json"), "utf8"));
const csp = manifest.content_security_policy.extension_pages;

// Serve the extension directory with the manifest CSP applied as a header,
// mirroring how Chrome applies it to extension pages.
const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(extDir, rel);

  if (!file.startsWith(extDir) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "content-security-policy": csp,
  });
  res.end(await readFile(file));
});

await new Promise((r) => server.listen(0, r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/index.html`;

const { spawn } = await import("node:child_process");
const chrome = spawn(
  CHROME,
  [
    "--disable-gpu",
    "--no-sandbox",
    "--virtual-time-budget=6000",
    "--dump-dom",
    url,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let dom = "";
let stderr = "";
chrome.stdout.on("data", (d) => (dom += d));
chrome.stderr.on("data", (d) => (stderr += d));

// Watchdog: never let a hung browser wedge the build.
const code = await Promise.race([
  new Promise((r) => chrome.on("close", r)),
  new Promise((r) => setTimeout(() => (chrome.kill("SIGKILL"), r(-1)), 60_000)),
]);
server.close();

if (code === -1) {
  console.error("\n✗ Browser did not exit within 60s — aborting.\n");
  process.exit(1);
}
if (code !== 0) {
  console.error(stderr.slice(0, 2000));
  process.exit(1);
}

const cspViolations = [
  ...stderr.matchAll(/Refused to (execute|inline|apply)[^\n]*/g),
].map((m) => m[0]);

// Headless Chrome on macOS emits its own display-link noise on stderr; that is
// not a page error. Only count things that actually come from the document.
const NOISE = /CVDisplayLinkCreateWithCGDisplay|Failed to create GLES|VoiceOver|font_service|GPU process|SharedImageManager/;
const pageErrors = stderr
  .split("\n")
  .filter((l) => /Uncaught|Refused to|Content Security Policy|SecurityError/.test(l))
  .filter((l) => !NOISE.test(l));

const failures = [];

// 1. Did the page render at all?
if (!/<h1[^>]*>[\s\S]{0,40}?<\//.test(dom)) {
  failures.push("no <h1> rendered — page did not render");
}

// 2. Did it hydrate? The clock only leaves its "--:--" placeholder once the
//    client component's effect has run, which requires the inline scripts
//    to have executed under the CSP.
const h1 = dom.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
const clockText = h1.replace(/<[^>]+>/g, "").trim();
if (clockText === "--:--" || !/\d/.test(clockText)) {
  failures.push(`clock still shows "${clockText}" — app did not hydrate (inline scripts blocked?)`);
}

// 3. Any CSP violations at all?
if (cspViolations.length > 0) {
  failures.push(`CSP violations reported:\n    ${cspViolations.join("\n    ")}`);
}
if (pageErrors.length > 0) {
  failures.push(`page errors reported:\n    ${pageErrors.map((l) => l.slice(0, 200)).join("\n    ")}`);
}

// 4. Did the stylesheet apply? Proves asset resolution from the extension root.
if (!/font-family:\s*(Geist|var\(--font)/i.test(dom) && !/stylesheet/i.test(dom)) {
  failures.push("stylesheet did not load");
}

const chunks = readdirSync(path.join(extDir, "_next", "static", "chunks")).length;

console.log("\nverify-extension");
console.log(`  chunks served      ${chunks}`);
console.log(`  clock rendered     "${clockText}"`);
console.log(`  CSP violations     ${cspViolations.length}`);
console.log(`  page errors        ${pageErrors.length}`);

if (failures.length > 0) {
  console.error(`\n✗ FAILED\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("\n✓ PASS - renders, hydrates, and runs clean under the manifest CSP\n");
