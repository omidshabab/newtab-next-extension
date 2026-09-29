# newtab-next-extension

A Chrome extension that replaces the new tab page, built with Next.js.

It is a normal Next.js app during development (`npm run dev`) that is compiled
into an unpacked Chrome extension (`npm run build:extension`). There is no
toolbar button and no popup — it only ever appears as the new tab.

## Quick start

```bash
npm install
npm run build:extension
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder
4. Open a new tab

After changing any source file, run `npm run build:extension` again and hit
reload on the extensions page.

## How the build works

`next build` produces a static export in `out/`, because an extension has no
server to render on demand. `scripts/build-extension.mjs` then copies the
minimum needed into `extension/` and writes `manifest.json`.

### Reserved filenames: why the assets live in `assets/`

Chrome refuses to load an unpacked extension if anything **at the top level**
of the folder starts with `_` — the prefix is reserved by the system. Next.js
emits an entire `_next/` tree, so a naive build produces this error:

```
Cannot load extension with file or directory name _next.
Filenames starting with "_" are reserved for use by the system.
```

The check is `CheckForIllegalFilenames` in Chromium's
`extensions/common/file_util.cc`, and it enumerates **non-recursively** — only
the root is inspected, so nested `_`-prefixed names are fine (`_locales`,
`_platform_specific` and `__MACOSX` are even explicitly allowed).

So the build nests the export one level down:

```
extension/
  assets/            <- top level is clean
    _next/static/…   <- unchanged, no rewriting
  index.html
  manifest.json
```

`assetPrefix: "/assets"` in `next.config.ts` is what makes Next emit
`/assets/_next/static/…` URLs to match. Nothing is textually rewritten, so the
runtime's own `/_next/` chunk base path stays valid — an earlier attempt to
rename the directory and patch that string silently broke hydration.

If you change `assetPrefix`, change `ASSETS_DIR` in
`scripts/build-extension.mjs` to match.

### The Content Security Policy problem

This is the other non-obvious part, and the reason the build script exists
rather than just running `next build`.

Manifest V3 applies `script-src 'self'` to extension pages, which **forbids
inline scripts**. A Next.js App Router export always inlines its RSC payload:

```html
<script>(self.__next_f = self.__next_f || []).push([0])</script>
<script>self.__next_f.push([1, "..."])</script>
```

So the page renders but never hydrates — dead clock, dead search box, console
errors.

Unlike CSP2, **MV3 will not let you relax the policy at all.** Both escape
hatches are rejected by Chrome at manifest parse time:

```
'content_security_policy.extension_pages': Insecure CSP value "'sha256-…'" in directive 'script-src'.
```

`'unsafe-inline'` is rejected the same way. Hashing the inline scripts does not
work, so the build script **removes them instead**: each inline `<script>` is
written to `assets/flight-N.js` and the tag is replaced with
`<script src="/assets/flight-N.js"></script>`.

That is safe here because those scripts only push onto `self.__next_f`, so
loading them as same-origin files in the same document order preserves the
semantics exactly — and `'self'` already permits them. The manifest CSP is then
just Chrome's documented minimum:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

The build fails if any inline script survives, so this cannot regress silently.

The build also hard-fails if it finds `eval` / `new Function` in a bundle, if a
referenced local file is missing, if any remote code is referenced, or if a
top-level name starts with `_`.

## Verifying

`npm run build:extension` runs the structural checks. To also check it in a real
browser:

```bash
PUPPETEER_CHROME="/path/to/chrome-headless-shell" npm run verify:extension
```

This serves `extension/` with the manifest CSP applied as a real header, loads
it in Chrome, and asserts the app rendered **and hydrated** — the clock shows a
real time rather than its server-rendered `--:--` placeholder. If you ever break
the CSP, this is what will tell you.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server, for iterating on the page |
| `npm run build:extension` | Static export → loadable `extension/` + manifest |
| `npm run verify:extension` | Render `extension/` in Chrome under its CSP and assert it hydrates |
| `npm run icons` | Regenerate `assets/icons/*.png` |
| `npm run lint` | ESLint |

## Layout

```
next.config.ts            output: "export" + assetPrefix "/assets"
scripts/
  build-extension.mjs     assembles extension/ , hashes inline scripts, writes manifest
  verify-extension.mjs    headless-Chrome hydration check
  generate-icons.mjs      writes the icon set (no image deps)
  lib/png.mjs             tiny PNG encoder used by the icon generator
assets/icons/             committed, so a clean clone builds as-is
src/app/                  the new tab page
src/components/new-tab.tsx  clock + search (client component)
extension/                build output — gitignored
  assets/_next/static/…   Next's output, nested so Chrome will load it
  assets/flight-N.js      the RSC payload, extracted out of index.html
```

## Notes for extending it

The manifest deliberately requests **no permissions**. To add browser data you
will need them, e.g. `topSites` for frequent links or `bookmarks` for a bookmark
bar — Chrome will show a permission prompt, and it keeps review simple if you
ask for only what you use.

Keep new interactive parts in a `"use client"` component. `src/app/page.tsx`
stays a server component so the static export keeps prerendering.

There is no background service worker. If you add one, it has to be a separate
file referenced by `background.service_worker` in the manifest, and it cannot be
part of the Next.js bundle.
