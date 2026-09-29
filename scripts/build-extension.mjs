import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembles the loadable Chrome extension in ./extension from Next.js' static
// export in ./out, and writes the MV3 manifest.
//
// Two Next.js/MV3 conflicts are resolved here:
//
// 1. Reserved filenames. Chrome's CheckForIllegalFilenames (extensions/common/
//    file_util.cc) walks only the TOP level of the extension root -- false for
//    "recurse" -- and rejects any name starting with "_", because Next.js emits
//    a whole `_next/` tree. So we nest the export under `assets/`: the top level
//    then holds only assets/, index.html and manifest.json, while every `_next`
//    URL Next emits keeps working untouched. `assetPrefix: "/assets"` in
//    next.config.ts is what makes those URLs line up. Nothing is rewritten.
//
// 2. Content Security Policy. MV3 applies `script-src 'self'` to extension
//    pages, which forbids inline scripts -- and a Next.js App Router export
//    always inlines its RSC payload as `<script>self.__next_f.push(...)</script>`.
//    Without help the page renders but never hydrates. The policy cannot be
//    relaxed: MV3 rejects both 'unsafe-inline' and 'sha256-…' hash sources, so
//    the payload is moved out into same-origin .js files, which 'self' allows.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
const extDir = path.join(root, "extension");
const iconsSrcDir = path.join(root, "assets", "icons");

// Must match `assetPrefix` in next.config.ts.
const ASSETS_DIR = "assets";
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

// Nest `_next` (and its leading underscore) under assets/. Chrome only inspects
// the top level, so this is what makes the extension loadable. The `_next` name
// is preserved below so the URLs Next generated keep resolving as-is.
if (await exists(path.join(outDir, "_next"))) {
  await cp(path.join(outDir, "_next"), path.join(extDir, ASSETS_DIR, "_next"), {
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

// --- 3. externalise the inline scripts --------------------------------------
//
// Manifest V3 applies `script-src 'self'` to extension pages. That forbids
// inline scripts, and unlike CSP2 you cannot relax the policy: MV3 rejects
// 'unsafe-inline' *and* 'sha256-…' hash sources. So the only way to ship the
// App Router payload is to stop inlining it.
//
// Next emits the RSC payload as
//   <script>(self.__next_f=self.__next_f||[]).push([0])</script>
//   <script>self.__next_f.push([1,"…"])</script>
// Both just push onto `self.__next_f`, so moving them into same-origin files
// loaded in the same document order preserves the semantics exactly. 'self'
// already covers them, so no CSP change is needed.

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const flightDir = path.join(extDir, ASSETS_DIR);
const flightFiles = [];

let page = await readFile(path.join(extDir, NEW_TAB_ENTRY), "utf8");

page = page.replace(SCRIPT_RE, (whole, attrs, body) => {
  if (/\bsrc\s*=/i.test(attrs)) return whole; // already a file, covered by 'self'
  if (/\S/.test(body) === false) return ""; // empty tag, drop it

  // A literal </script> inside the payload would already have terminated the
  // original tag, so its absence is a sanity check, not a transformation.
  if (/<\/script/i.test(body)) {
    fail("Inline script contains a literal </script> and cannot be externalised.");
  }

  const name = `flight-${flightFiles.length}.js`;
  flightFiles.push({ name, body });
  return `<script src="/${ASSETS_DIR}/${name}"></script>`;
});

await mkdir(flightDir, { recursive: true });
for (const { name, body } of flightFiles) {
  await writeFile(path.join(flightDir, name), body);
}
await writeFile(path.join(extDir, NEW_TAB_ENTRY), page);

// Nothing inline may survive: 'self' cannot execute it and Chrome will refuse
// the manifest before the page ever runs.
const remainingInline = [...page.matchAll(SCRIPT_RE)].filter(
  ([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && /\S/.test(body),
);
if (remainingInline.length > 0) {
  fail(`${remainingInline.length} inline script(s) survived; MV3 would block them.`);
}

const inlineCount = 0;
const html = page;

// --- 4. verify the export is actually extension-safe ------------------------

const problems = [];

const collectJs = async (dir) => {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJs(full)));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
};

const assetsDir = path.join(extDir, ASSETS_DIR);

// Chrome's CheckForIllegalFilenames only looks at the top level of the extension
// root, and reports the failure as a generic "Could not load manifest" -- so
// catch it here, where the error can actually be explained.
for (const entry of await readdir(extDir)) {
  if (entry.startsWith("_") && entry !== "__MACOSX") {
    problems.push(
      `"${entry}" starts with "_" at the top level; Chrome reserves that prefix and will not load the extension`,
    );
  }
}

// MV3 forbids eval / new Function.
if (await exists(assetsDir)) {
  for (const file of await collectJs(assetsDir)) {
    const code = await readFile(file, "utf8");
    if (/\beval\s*\(/.test(code) || /new\s+Function\s*\(/.test(code)) {
      problems.push(`${path.relative(extDir, file)} uses eval/new Function, which MV3 blocks`);
    }
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

// MV3 will not let the extension_pages policy be relaxed, so this is the
// documented minimum and nothing more.
const csp = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

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

const chunkCount = (await exists(assetsDir)) ? (await collectJs(assetsDir)).length : 0;

console.log("\nBuilt extension/");
console.log(`  entry          ${NEW_TAB_ENTRY}`);
console.log(`  scripts        ${chunkCount} external chunk(s)`);
console.log(`  flight files   ${flightFiles.length} (extracted from inline)`);
console.log(`  inline scripts ${inlineCount}`);
console.log(`  permissions    none requested`);
console.log(`\nLoad it: chrome://extensions → Developer mode → Load unpacked → ./extension`);
console.log("Run  npm run build:extension  after changing the app.\n");
