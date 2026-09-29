import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembles the loadable Chrome extension in ./extension from Next.js' static
// export in ./out, and writes the MV3 manifest.
//
// The interesting part is the Content Security Policy. Manifest V3 applies
// `script-src 'self'` to extension pages, which forbids inline scripts -- and
// a Next.js App Router export always inlines its RSC payload as
// `<script>self.__next_f.push(...)</script>`. Without help the page renders but
// never hydrates. MV3 will not accept 'unsafe-inline', so instead we hash each
// inline script with SHA-256 and allow exactly those via the manifest CSP.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
const extDir = path.join(root, "extension");
const iconsSrcDir = path.join(root, "assets", "icons");
const NEW_TAB_ENTRY = "index.html";
const ICON_SIZES = [16, 32, 48, 128];

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// --- 1. sanity check the Next.js export -------------------------------------

if (!(await exists(outDir))) {
  fail("No ./out directory found. Run `next build` first (`npm run build:extension` does both).");
}
if (!(await exists(path.join(outDir, NEW_TAB_ENTRY)))) {
  fail(`Static export is missing ${NEW_TAB_ENTRY}.`);
}

// --- 2. assemble the extension directory ------------------------------------

await rm(extDir, { recursive: true, force: true });
await mkdir(extDir, { recursive: true });

await cp(path.join(outDir, NEW_TAB_ENTRY), path.join(extDir, NEW_TAB_ENTRY));

if (await exists(path.join(outDir, "_next", "static"))) {
  await cp(path.join(outDir, "_next", "static"), path.join(extDir, "_next", "static"), {
    recursive: true,
  });
}

// Icons are committed to the repo, so just verify they are all present.
for (const size of ICON_SIZES) {
  const from = path.join(iconsSrcDir, `icon${size}.png`);
  if (!(await exists(from))) {
    fail(`Missing assets/icons/icon${size}.png. Run \`npm run icons\`.`);
  }
  await cp(from, path.join(extDir, `icon${size}.png`));
}

// The favicon Next emits from src/app/favicon.ico.
if (await exists(path.join(outDir, "favicon.ico"))) {
  await cp(path.join(outDir, "favicon.ico"), path.join(extDir, "favicon.ico"));
}

// --- 3. hash the inline scripts ---------------------------------------------
//
// <script> is an HTML raw-text element: the parser hands the exact bytes
// between the tags to the script engine without decoding entities. Hashing
// that raw slice therefore matches what the browser hashes.

const html = await readFile(path.join(extDir, NEW_TAB_ENTRY), "utf8");

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const hashes = new Set();
let inlineCount = 0;

for (const match of html.matchAll(SCRIPT_RE)) {
  const [, attrs, body] = match;
  if (/\bsrc\s*=/i.test(attrs)) continue; // external, already covered by 'self'
  inlineCount += 1;
  hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
}

// --- 4. verify the export is actually extension-safe ------------------------

const problems = [];

// MV3 forbids eval / new Function.

const collectJs = async (dir) => {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJs(full)));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
};

for (const file of await collectJs(path.join(extDir, "_next", "static"))) {
  const code = await readFile(file, "utf8");
  if (/\beval\s*\(/.test(code) || /new\s+Function\s*\(/.test(code)) {
    problems.push(`${path.relative(extDir, file)} uses eval/new Function, which MV3 blocks`);
  }
}

// Every locally referenced asset must exist, and nothing may load remote *code*.
// Note we only inspect resource-loading tags: a plain <a href> to an external
// site is perfectly legal in an extension.
const RESOURCE_TAG_RE =
  /<(script|link|img|iframe|source|video|audio|embed)\b([^>]*)>/gi;
const URL_ATTR_RE = /(?:src|href)\s*=\s*"([^"]+)"/gi;

for (const [, tag, attrs] of html.matchAll(RESOURCE_TAG_RE)) {
  for (const [, url] of attrs.matchAll(URL_ATTR_RE)) {
    if (/^(https?:)?\/\//i.test(url)) {
      problems.push(`Remote ${tag} resource referenced from HTML: ${url}`);
      continue;
    }
    if (!url.startsWith("/")) continue; // relative, or an inline data: URI
    const target = path.join(extDir, url.slice(1).split("?")[0]);
    if (!(await exists(target))) {
      problems.push(`HTML <${tag}> references missing file: ${url}`);
    }
  }
}

if (problems.length > 0) {
  fail(`Extension is not MV3-safe:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

// --- 5. write the manifest --------------------------------------------------

const csp = [
  // The hashes must be source expressions *within* script-src, not separate
  // directives -- joining them with ';' would produce an invalid policy.
  ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(" "),
  "object-src 'self'",
].join("; ");

// Guard against emitting a malformed policy: every ';'-separated directive must
// be a directive name followed by at least one source expression.
for (const directive of csp.split(";").map((d) => d.trim()).filter(Boolean)) {
  const parts = directive.split(/\s+/);
  if (parts.length < 2 || !/^[a-z][a-z0-9-]*$/i.test(parts[0])) {
    fail(`Generated an invalid CSP directive: "${directive}"`);
  }
}

const manifest = {
  manifest_version: 3,
  name: "New Tab",
  version: pkg.version,
  description: "A minimal new tab page built with Next.js.",
  icons: Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icon${s}.png`])),
  // Replaces the new tab page. Deliberately no "action" key: the extension has
  // no toolbar button and therefore no popup.
  chrome_url_overrides: { newtab: NEW_TAB_ENTRY },
  content_security_policy: { extension_pages: csp },
};

await writeFile(path.join(extDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// --- 6. report --------------------------------------------------------------

const chunkCount = (await collectJs(path.join(extDir, "_next", "static"))).length;

console.log("\nBuilt extension/");
console.log(`  entry          ${NEW_TAB_ENTRY}`);
console.log(`  scripts        ${chunkCount} external chunk(s), ${inlineCount} inline`);
console.log(`  CSP hashes     ${hashes.size}`);
console.log(`  permissions    none requested`);
console.log(`\nLoad it: chrome://extensions → Developer mode → Load unpacked → ./extension`);
console.log("Run  npm run build:extension  after changing the app.\n");
