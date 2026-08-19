// Generates build/icon.icns for the packaged app: a dusk-over-the-playa mark
// drawn per-pixel (no image dependencies), converted with sips + iconutil.
// Rerun after changing the drawing: node scripts/make-icon.mjs

import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 1024;

// --- minimal PNG encoder ----------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- drawing ----------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Rounded-rect coverage (macOS-style tile: content inset with big radius).
function tileAlpha(x, y) {
  const inset = 92, radius = 210;
  const half = SIZE / 2 - inset;
  const dx = Math.max(Math.abs(x - SIZE / 2) - (half - radius), 0);
  const dy = Math.max(Math.abs(y - SIZE / 2) - (half - radius), 0);
  const d = Math.hypot(dx, dy) - radius;
  return 1 - smooth(-1.5, 1.5, d);
}

const SKY_TOP = [13, 22, 46];
const SKY_WARM = [196, 108, 58];
const SUN_CORE = [255, 214, 138];
const SUN_EDGE = [246, 152, 74];
const PLAYA_TOP = [46, 30, 26];
const PLAYA_BOT = [12, 13, 22];
const HORIZON_GLOW = [255, 209, 150];

function draw() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const horizonY = SIZE * 0.66;
  const sun = { x: SIZE / 2, y: SIZE * 0.52, r: 148 };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = tileAlpha(x, y);
      let c;
      if (y < horizonY) {
        // Dusk sky: navy overhead warming toward the horizon.
        c = mix(SKY_TOP, SKY_WARM, smooth(0.15, 1, y / horizonY) * 0.9);
        const d = Math.hypot(x - sun.x, y - sun.y);
        // Wide soft glow, then a crisp disc.
        c = mix(c, SUN_EDGE, 0.55 * smooth(sun.r * 2.6, sun.r * 0.9, d));
        const disc = smooth(sun.r + 2, sun.r - 2, d);
        const core = mix(SUN_CORE, SUN_EDGE, smooth(0, sun.r, d));
        c = mix(c, core, disc);
        // Dust shimmer right on the horizon line.
        c = mix(c, HORIZON_GLOW, 0.8 * smooth(26, 0, horizonY - y));
      } else {
        c = mix(PLAYA_TOP, PLAYA_BOT, smooth(0, 1, (y - horizonY) / (SIZE - horizonY)));
        c = mix(c, HORIZON_GLOW, 0.35 * smooth(10, 0, y - horizonY));
      }
      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.round(c[0] * a);
      rgba[i + 1] = Math.round(c[1] * a);
      rgba[i + 2] = Math.round(c[2] * a);
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

// --- iconset → icns ---------------------------------------------------------

const buildDir = join(ROOT, "build");
const iconset = join(buildDir, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const master = join(buildDir, "icon-1024.png");
writeFileSync(master, encodePng(draw(), SIZE));

for (const pts of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = pts * scale;
    const name = `icon_${pts}x${pts}${scale === 2 ? "@2x" : ""}.png`;
    execFileSync("sips", ["-z", String(px), String(px), master, "--out", join(iconset, name)], { stdio: "ignore" });
  }
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });
console.log("wrote build/icon.icns");
