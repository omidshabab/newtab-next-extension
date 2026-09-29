import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng } from "./lib/png.mjs";

// Generates the extension icon set. Output is committed to the repo, so a
// clean clone can build without re-running this script.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "icons");

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4; // render at 4x then box-filter down, for smooth edges

// Rounded square, indigo -> violet, with a white ring and centre dot.
const TOP = [0x63, 0x66, 0xf1];
const BOTTOM = [0xa8, 0x55, 0xf7];
const RADIUS = 0.22; // corner radius, as a fraction of the icon size

function roundedBoxCoverage(px, py, half, radius) {
  // Signed distance to a rounded box centred on the origin.
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function ringCoverage(px, py, outer, inner) {
  const d = Math.hypot(px, py);
  if (d > outer) return false;
  return d >= inner;
}

function discCoverage(px, py, r) {
  return Math.hypot(px, py) <= r;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = SUPERSAMPLE;
  const step = 1 / size;
  const half = 0.5;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          // Sample point in [-0.5, 0.5] space.
          const fx = (x + (sx + 0.5) / ss) * step - half;
          const fy = (y + (sy + 0.5) / ss) * step - half;

          if (roundedBoxCoverage(fx, fy, half - step, RADIUS * half) > 0) {
            continue; // outside the rounded square
          }

          const t = (y + (sy + 0.5) / ss) * step;
          let cr = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
          let cg = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
          let cb = TOP[2] + (BOTTOM[2] - TOP[2]) * t;

          // White ring + centre dot on top of the gradient.
          const glyph = ringCoverage(fx, fy, 0.3, 0.17) || discCoverage(fx, fy, 0.075);
          if (glyph) {
            cr = 255;
            cg = 255;
            cb = 255;
          }

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const samples = ss * ss;
      const idx = (y * size + x) * 4;
      const alpha = a / samples;
      // Average colour only across covered samples, to avoid dark fringing.
      const covered = alpha === 0 ? 1 : a / 255;
      rgba[idx] = Math.round(r / covered);
      rgba[idx + 1] = Math.round(g / covered);
      rgba[idx + 2] = Math.round(b / covered);
      rgba[idx + 3] = Math.round(alpha);
    }
  }

  return encodePng(size, size, rgba);
}

await mkdir(outDir, { recursive: true });

for (const size of SIZES) {
  const file = path.join(outDir, `icon${size}.png`);
  await writeFile(file, render(size));
  console.log(`  icon${size}.png`);
}

console.log(`\nWrote ${SIZES.length} icons to assets/icons/`);
