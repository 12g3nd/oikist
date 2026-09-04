/**
 * Generates `build/icon.ico`, the app's taskbar and window icon.
 *
 * The mark is a rune built from O, I and K: a squared C, a full-height bar, and a pair
 * of arms meeting at a point. Written as geometry rather than pulled from an image
 * library — it is a handful of polygons, cheaper than a dependency, and it re-renders at
 * every size, so the small versions are *drawn* rather than downscaled from 256 and
 * turned to mush.
 *
 * It sits on a transparent ground in the accent colour. A dark tile disappeared into a
 * dark taskbar, which is where this icon actually has to be found.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [256, 64, 48, 32, 24, 16];

const MARK = [79, 199, 190]; // --accent

/** Sub-samples per axis. 4 means 16 coverage tests per pixel, which is plenty here. */
const SAMPLES = 4;

// --- the rune, in normalised coordinates with y running down ---
//
// Every gap is deliberate and none is smaller than it has to be: at 24px a gap of 0.05
// is barely one pixel, and two forms that merge stop being three letters.

const O_OUTER = { x0: 0.10, y0: 0.17, x1: 0.36, y1: 0.83, radius: 0.07 };
const O_INNER = { x0: 0.205, y0: 0.285, x1: 0.38, y1: 0.715 };
const I_BAR = { x0: 0.42, y0: 0.09, x1: 0.53, y1: 0.91 };
const K_VERTEX = [0.635, 0.50];
const K_UPPER = [0.88, 0.21];
const K_LOWER = [0.88, 0.79];
const K_HALF_WIDTH = 0.056;

function inRect(x, y, r) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** A rectangle with all four corners rounded by `radius`. */
function inRoundRect(x, y, r) {
  if (!inRect(x, y, r)) {
    return false;
  }
  const cx = Math.min(Math.max(x, r.x0 + r.radius), r.x1 - r.radius);
  const cy = Math.min(Math.max(y, r.y0 + r.radius), r.y1 - r.radius);
  return Math.hypot(x - cx, y - cy) <= r.radius;
}

/** A thick straight arm, built as a quad so its ends stay square rather than rounded. */
function inArm(x, y, [ax, ay], [bx, by], half) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  // Distance along the arm, and distance out from its centre line.
  const along = ((x - ax) * dx + (y - ay) * dy) / length;
  const across = Math.abs((x - ax) * -dy + (y - ay) * dx) / length;
  return along >= 0 && along <= length && across <= half;
}

function inRune(x, y) {
  const o = inRoundRect(x, y, O_OUTER) && !inRect(x, y, O_INNER);
  return (
    o ||
    inRect(x, y, I_BAR) ||
    inArm(x, y, K_VERTEX, K_UPPER, K_HALF_WIDTH) ||
    inArm(x, y, K_VERTEX, K_LOWER, K_HALF_WIDTH)
  );
}

/** One RGBA raster at `size`, anti-aliased by super-sampling. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (inRune(x, y)) {
            hits += 1;
          }
        }
      }
      if (hits === 0) {
        continue;
      }
      const offset = (py * size + px) * 4;
      pixels[offset] = MARK[0];
      pixels[offset + 1] = MARK[1];
      pixels[offset + 2] = MARK[2];
      pixels[offset + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

// --- PNG ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function toPng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha

  // Every scanline carries filter type 0: these images are tiny and a filter would trade
  // clarity here for bytes nobody is counting.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// --- ICO ---

const images = SIZES.map((size) => ({ size, png: toPng(render(size), size) }));

const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(0, 0);
directory.writeUInt16LE(1, 2); // an icon, not a cursor
directory.writeUInt16LE(images.length, 4);

let offset = directory.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  // 256 is written as 0: the field is one byte, so the largest size wraps to zero by the
  // format's own convention.
  const dimension = image.size === 256 ? 0 : image.size;
  directory[entry] = dimension;
  directory[entry + 1] = dimension;
  directory[entry + 2] = 0;
  directory[entry + 3] = 0;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.png.length;
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "build", "icon.ico");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([directory, ...images.map((image) => image.png)]));
console.log(`wrote ${target} (${SIZES.join(", ")} px)`);

// The 256px face is also written as a PNG for the README, so the mark in the docs and
// the mark on the taskbar can never drift apart.
const readmeIcon = join(root, "docs", "screenshots", "icon.png");
mkdirSync(dirname(readmeIcon), { recursive: true });
writeFileSync(readmeIcon, images[0].png);
console.log(`wrote ${readmeIcon}`);
