// Generates the PWA icons (roadmap 4.1) without image dependencies: a white
// envelope glyph on the brand blue, rasterized with 4x4 supersampling and
// written as PNG via node:zlib. Output is checked in under public/icons/;
// re-run after changing the design: node apps/web/scripts/generate-icons.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const BRAND = [0x12, 0x73, 0xde]
const WHITE = [0xff, 0xff, 0xff]
const SAMPLES = 4

/** Inside test for a rounded rectangle (all coordinates in 0..1 units). */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

/**
 * Envelope inside a box of `scale` (fraction of the icon) centered in the
 * icon: white body with the flap drawn as a blue "V" cut-out.
 */
function envelope(x, y, scale) {
  const w = scale
  const h = scale * 0.7
  const left = 0.5 - w / 2
  const top = 0.5 - h / 2
  const right = left + w
  const bottom = top + h
  if (!inRoundedRect(x, y, left, top, right, bottom, w * 0.09)) return null
  const stroke = w * 0.075
  const inset = w * 0.13
  const tipY = top + h * 0.56
  const flap =
    distanceToSegment(x, y, left + inset, top + inset, 0.5, tipY) < stroke / 2 ||
    distanceToSegment(x, y, right - inset, top + inset, 0.5, tipY) < stroke / 2
  return flap ? 'brand' : 'white'
}

/**
 * kind 'any': rounded square with transparent corners; 'maskable' and
 * 'apple': full-bleed background (maskable keeps the glyph inside the 80 %
 * safe zone; iOS rounds the corners itself and ignores transparency).
 */
function pixel(x, y, kind) {
  const background = kind === 'any' ? inRoundedRect(x, y, 0, 0, 1, 1, 0.2) : true
  if (!background) return null
  const glyph = envelope(x, y, kind === 'maskable' ? 0.5 : 0.6)
  return glyph === 'white' ? WHITE : BRAND
}

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function renderPng(size, kind) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1)
    raw[row] = 0 // filter: none
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = pixel(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
            kind,
          )
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          a += 1
        }
      }
      const offset = row + 1 + px * 4
      raw[offset] = a ? Math.round(r / a) : 0
      raw[offset + 1] = a ? Math.round(g / a) : 0
      raw[offset + 2] = a ? Math.round(b / a) : 0
      raw[offset + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const ICONS = [
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['maskable-192.png', 192, 'maskable'],
  ['maskable-512.png', 512, 'maskable'],
  ['apple-touch-icon.png', 180, 'apple'],
  ['favicon-32.png', 32, 'any'],
]

for (const [name, size, kind] of ICONS) {
  writeFileSync(join(OUT_DIR, name), renderPng(size, kind))
  console.log(`wrote ${name}`)
}
