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

### The Content Security Policy problem

This is the one non-obvious part, and the reason `build:extension` exists
rather than just running `next build`.

Manifest V3 applies `script-src 'self'` to extension pages, which **forbids
inline scripts**. A Next.js App Router export always inlines its RSC payload:

```html
<script>(self.__next_f = self.__next_f || []).push([0])</script>
<script>self.__next_f.push([1, "..."])</script>
```

So the page would render but never hydrate — no interactivity, and a pile of
console errors. MV3 does not accept `'unsafe-inline'`, so the fix is to allow
exactly those scripts by hash. The build script SHA-256-hashes every inline
script it finds and writes the results into the manifest:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval' 'sha256-OBTN3…' 'sha256-81Cg4…'; object-src 'self'"
}
```

Because `<script>` is an HTML raw-text element, the parser hands its exact
bytes to the script engine without decoding entities — so hashing the raw
slice of the file is precisely what the browser hashes.

**Consequence:** the hashes are build-specific. Always rebuild the extension
after changing the app; editing `out/` or `extension/` by hand will break the CSP.

The build also hard-fails if it finds `eval` / `new Function` in a bundle, if a
referenced local file is missing, or if any remote code is referenced — all
things MV3 rejects at load time.

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
next.config.ts            output: "export" — no server at runtime
scripts/
  build-extension.mjs     assembles extension/ , hashes inline scripts, writes manifest
  verify-extension.mjs    headless-Chrome hydration check
  generate-icons.mjs      writes the icon set (no image deps)
  lib/png.mjs             tiny PNG encoder used by the icon generator
assets/icons/             committed, so a clean clone builds as-is
src/app/                  the new tab page
src/components/new-tab.tsx  clock + search (client component)
extension/                build output — gitignored
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
