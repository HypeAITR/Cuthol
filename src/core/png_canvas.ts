/**
 * Pure TypeScript Deterministic RGBA Canvas & PNG Encoder for Cuthol.
 *
 * Uses Node's built-in `node:zlib` (`deflateSync`) and a built-in 5x7 ASCII bitmap font
 * to draw crisp waveform envelopes, 3-band spectral plots, silence markers,
 * time rulers, and bounding boxes with zero external native image dependencies.
 */

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

export type RgbaColor = [number, number, number, number];

// Compact 5x7 bitmap font for printable ASCII (32..95 + lowercase mapped to uppercase)
const FONT_5X7: Record<string, number[]> = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00],
  "!": [0x00, 0x00, 0x5f, 0x00, 0x00],
  '"': [0x00, 0x07, 0x00, 0x07, 0x00],
  "#": [0x14, 0x7f, 0x14, 0x7f, 0x14],
  $: [0x24, 0x2a, 0x7f, 0x2a, 0x12],
  "%": [0x23, 0x13, 0x08, 0x64, 0x62],
  "&": [0x36, 0x49, 0x55, 0x22, 0x50],
  "'": [0x00, 0x05, 0x03, 0x00, 0x00],
  "(": [0x00, 0x1c, 0x22, 0x41, 0x00],
  ")": [0x00, 0x41, 0x22, 0x1c, 0x00],
  "*": [0x14, 0x08, 0x3e, 0x08, 0x14],
  "+": [0x08, 0x08, 0x3e, 0x08, 0x08],
  ",": [0x00, 0x50, 0x30, 0x00, 0x00],
  "-": [0x08, 0x08, 0x08, 0x08, 0x08],
  ".": [0x00, 0x60, 0x60, 0x00, 0x00],
  "/": [0x20, 0x10, 0x08, 0x04, 0x02],
  "0": [0x3e, 0x51, 0x49, 0x45, 0x3e],
  "1": [0x00, 0x42, 0x7f, 0x40, 0x00],
  "2": [0x42, 0x61, 0x51, 0x49, 0x46],
  "3": [0x21, 0x41, 0x45, 0x4b, 0x31],
  "4": [0x18, 0x14, 0x12, 0x7f, 0x10],
  "5": [0x27, 0x45, 0x45, 0x45, 0x39],
  "6": [0x3c, 0x4a, 0x49, 0x49, 0x30],
  "7": [0x01, 0x71, 0x09, 0x05, 0x03],
  "8": [0x36, 0x49, 0x49, 0x49, 0x36],
  "9": [0x06, 0x49, 0x49, 0x29, 0x1e],
  ":": [0x00, 0x36, 0x36, 0x00, 0x00],
  ";": [0x00, 0x56, 0x36, 0x00, 0x00],
  "<": [0x08, 0x14, 0x22, 0x41, 0x00],
  "=": [0x14, 0x14, 0x14, 0x14, 0x14],
  ">": [0x00, 0x41, 0x22, 0x14, 0x08],
  "?": [0x02, 0x01, 0x51, 0x09, 0x06],
  "@": [0x32, 0x49, 0x79, 0x41, 0x3e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  "[": [0x00, 0x7f, 0x41, 0x41, 0x00],
  "\\": [0x02, 0x04, 0x08, 0x10, 0x20],
  "]": [0x00, 0x41, 0x41, 0x7f, 0x00],
  "^": [0x04, 0x02, 0x01, 0x02, 0x04],
  _: [0x40, 0x40, 0x40, 0x40, 0x40],
  "`": [0x00, 0x01, 0x02, 0x04, 0x00],
  "{": [0x00, 0x08, 0x36, 0x41, 0x00],
  "|": [0x00, 0x00, 0x7f, 0x00, 0x00],
  "}": [0x00, 0x41, 0x36, 0x08, 0x00],
  "~": [0x08, 0x04, 0x08, 0x10, 0x08],
};

const TURKISH_ASCII_MAP: Record<string, string> = {
  Ç: "C",
  ç: "C",
  Ğ: "G",
  ğ: "G",
  İ: "I",
  ı: "I",
  Ö: "O",
  ö: "O",
  Ş: "S",
  ş: "S",
  Ü: "U",
  ü: "U",
};

// CRC32 table for PNG chunk integrity
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export class PngCanvas {
  public readonly width: number;
  public readonly height: number;
  public readonly pixels: Uint8Array;

  constructor(width: number, height: number, bg: RgbaColor = [13, 15, 18, 255]) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  public setPixel(x: number, y: number, color: RgbaColor): void {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height) return;
    const idx = (iy * this.width + ix) * 4;
    const srcA = Math.max(0, Math.min(255, color[3])) / 255;
    if (srcA >= 0.999) {
      this.pixels[idx] = color[0];
      this.pixels[idx + 1] = color[1];
      this.pixels[idx + 2] = color[2];
      this.pixels[idx + 3] = 255;
    } else if (srcA > 0) {
      const dstA = this.pixels[idx + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA > 0) {
        this.pixels[idx] = Math.round((color[0] * srcA + this.pixels[idx] * dstA * (1 - srcA)) / outA);
        this.pixels[idx + 1] = Math.round((color[1] * srcA + this.pixels[idx + 1] * dstA * (1 - srcA)) / outA);
        this.pixels[idx + 2] = Math.round((color[2] * srcA + this.pixels[idx + 2] * dstA * (1 - srcA)) / outA);
        this.pixels[idx + 3] = Math.round(outA * 255);
      }
    }
  }

  public fillRect(x: number, y: number, w: number, h: number, color: RgbaColor): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return;
    }
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        this.setPixel(px, py, color);
      }
    }
  }

  public strokeRect(x: number, y: number, w: number, h: number, thickness: number, color: RgbaColor): void {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      !Number.isFinite(thickness) ||
      w <= 0 ||
      h <= 0 ||
      thickness <= 0
    ) {
      return;
    }
    const rx = Math.round(x);
    const ry = Math.round(y);
    const rw = Math.round(w);
    const rh = Math.round(h);
    if (rw <= 0 || rh <= 0) return;
    const rt = Math.max(1, Math.round(thickness));
    const tH = Math.min(rt, Math.ceil(rh / 2));
    const tW = Math.min(rt, Math.ceil(rw / 2));
    this.fillRect(rx, ry, rw, tH, color);
    if (rh > tH) {
      this.fillRect(rx, ry + rh - Math.min(tH, rh - tH), rw, Math.min(tH, rh - tH), color);
    }
    const innerH = rh - 2 * tH;
    if (innerH > 0) {
      this.fillRect(rx, ry + tH, tW, innerH, color);
      if (rw > tW) {
        this.fillRect(rx + rw - Math.min(tW, rw - tW), ry + tH, Math.min(tW, rw - tW), innerH, color);
      }
    }
  }

  public drawLine(x0: number, y0: number, x1: number, y1: number, color: RgbaColor, _thickness = 1): void {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
      return;
    }
    let ix0 = Math.round(x0);
    let iy0 = Math.round(y0);
    const ix1 = Math.round(x1);
    const iy1 = Math.round(y1);
    const dx = Math.abs(ix1 - ix0);
    const sx = ix0 < ix1 ? 1 : -1;
    const dy = -Math.abs(iy1 - iy0);
    const sy = iy0 < iy1 ? 1 : -1;
    let err = dx + dy;
    const maxSteps = Math.min(this.width * this.height + 4096, dx - dy + 2);
    for (let step = 0; step < maxSteps; step++) {
      this.setPixel(ix0, iy0, color);
      if (ix0 === ix1 && iy0 === iy1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ix0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        iy0 += sy;
      }
    }
  }

  public drawText(text: string, x: number, y: number, color: RgbaColor, scale = 2): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || scale <= 0) {
      return;
    }
    let cursorX = Math.floor(x);
    for (let i = 0; i < text.length; i++) {
      const rawCh = text[i];
      const ch = TURKISH_ASCII_MAP[rawCh] ?? rawCh.toUpperCase();
      const glyph = FONT_5X7[ch] ?? FONT_5X7["?"];
      for (let col = 0; col < 5; col++) {
        const colBits = glyph[col];
        for (let row = 0; row < 7; row++) {
          if ((colBits >> row) & 1) {
            this.fillRect(cursorX + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      cursorX += 6 * scale;
    }
  }

  public toPngBuffer(): Buffer {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = 6; // RGBA color type
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    // Each scanline starts with filter byte 0 (None)
    const rowStride = this.width * 4 + 1;
    const rawData = Buffer.alloc(rowStride * this.height);
    for (let y = 0; y < this.height; y++) {
      const rowStart = y * rowStride;
      rawData[rowStart] = 0;
      const srcStart = y * this.width * 4;
      rawData.set(this.pixels.subarray(srcStart, srcStart + this.width * 4), rowStart + 1);
    }

    const compressed = zlib.deflateSync(rawData, { level: 6 });
    return Buffer.concat([
      signature,
      makePngChunk("IHDR", ihdr),
      makePngChunk("IDAT", compressed),
      makePngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  public saveAs(filePath: string): void {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, this.toPngBuffer());
  }
}
