/**
 * Generates `build/icon.ico`, the app's taskbar and window icon.
 *
 * Written by hand rather than pulled from an image library: the whole icon is a dark
 * tile, a chevron and a cursor block, which is a few distance functions — cheaper than a
 * dependency, and it re-renders at every size so the 16px version is drawn rather than
 * downscaled from 256 and turned to mush.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [256, 64, 48, 32, 16];

const BG = [15, 18, 17];       // --bg, the terminal ground
const EDGE = [42, 51, 47];     // --border
const MARK = [79, 199, 190];   // --accent

/** Distance from a point to a line segment, in normalised units. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage of a rounded square, 1 inside, 0 outside, feathered at the edge. */
function tileCoverage(x, y, radius, feather) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  const distance = Math.hypot(dx, dy) - radius;
  return Math.max(0, Math.min(1, 0.5 - distance / feather));
}

function mix(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha)
  ];
}

/**
 * One RGBA raster of the icon at `size`.
 *
 * The mark is a prompt chevron and a cursor block — a terminal, which is what the app
 * looks like, and two shapes is all that survives 16 pixels.
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  // A thicker stroke at small sizes: 1.5px of a 16px tile disappears, and an icon that
  // reads as a grey smudge is worse than a blunt one.
  const stroke = size <= 32 ? 0.085 : 0.065;
  const feather = 1 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      const tile = tileCoverage(u, v, 0.18, feather * 1.5);
      if (tile <= 0) {
        continue;
      }

      // A one-pixel lip of border colour, so the tile has an edge on a dark taskbar.
      const inner = tileCoverage(u, v, 0.18, feather * 1.5) - tileCoverage(u, v, 0.17, feather * 1.5) * 0;
      let colour = size >= 32 && inner > 0 && tile < 1 ? EDGE : BG;

      const chevron = Math.min(
        distanceToSegment(u, v, 0.30, 0.31, 0.50, 0.50),
        distanceToSegment(u, v, 0.50, 0.50, 0.30, 0.69)
      );
      const onChevron = Math.max(0, Math.min(1, (stroke - chevron) / feather));

      const cursor = Math.max(Math.abs(u - 0.655) - 0.095, Math.abs(v - 0.655) - 0.045);
      const onCursor = Math.max(0, Math.min(1, -cursor / feather));

      const ink = Math.max(onChevron, onCursor);
      if (ink > 0) {
        colour = mix(colour, MARK, ink);
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = Math.round(tile * 255);
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

  // Every scanline carries filter type 0: the images are tiny and a filter would only
  // trade clarity here for bytes nobody counts.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
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
  // 256 is written as 0: the field is one byte, so the largest size wraps to zero by
  // the format's own convention.
  directory[entry] = image.size === 256 ? 0 : image.size;
  directory[entry + 1] = image.size === 256 ? 0 : image.size;
  directory[entry + 2] = 0;
  directory[entry + 3] = 0;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.png.length;
});

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.ico");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([directory, ...images.map((image) => image.png)]));
console.log(`wrote ${target} (${SIZES.join(", ")} px)`);
