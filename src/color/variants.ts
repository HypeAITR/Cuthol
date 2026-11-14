// Side-by-side variant sheet (untouched first) for comparing grades (owner: measurement).
import fs from "node:fs";
import path from "node:path";
import { PngCanvas } from "../core/png_canvas.js";
import type { ColorFrameSet } from "./types.js";

export interface ColorVariant {
  label: string;
  fn: (p: [number, number, number]) => void;
}

function drawText(canvas: PngCanvas, x: number, y: number, text: string): void {
  canvas.drawText(text.toUpperCase().slice(0, 40), x, y, [255, 255, 255, 255], 1);
}

export function renderVariantSheet(opts: {
  source: ColorFrameSet;
  variants: ColorVariant[];
  outPng: string;
}): { png: string; lines: string[] } {
  const frames = opts.source.frames;
  const fw = opts.source.width;
  const fh = opts.source.height;
  const cols = 1 + opts.variants.length;
  const labelH = 20;
  const W = fw * cols;
  const H = fh + labelH;
  const canvas = new PngCanvas(W, H, [13, 15, 18, 255]);
  const paint = (col: number, frame: Float32Array, label: string): void => {
    drawText(canvas, col * fw + 4, 6, label);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const sx = Math.min(fw - 1, Math.floor((x / fw) * fw));
        const sy = Math.min(fh - 1, Math.floor((y / fh) * fh));
        const i = (sy * fw + sx) * 3;
        canvas.setPixel(col * fw + x, labelH + y, [
          Math.round(Math.min(1, Math.max(0, frame[i])) * 255),
          Math.round(Math.min(1, Math.max(0, frame[i + 1])) * 255),
          Math.round(Math.min(1, Math.max(0, frame[i + 2])) * 255),
          255,
        ]);
      }
    }
  };
  const mid = frames[Math.floor(frames.length / 2)];
  paint(0, mid, "untouched");
  opts.variants.forEach((v, k) => {
    const out = new Float32Array(mid.length);
    const p: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < mid.length; i += 3) {
      p[0] = mid[i]; p[1] = mid[i + 1]; p[2] = mid[i + 2];
      v.fn(p);
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
    }
    paint(k + 1, out, v.label);
  });
  fs.mkdirSync(path.dirname(opts.outPng), { recursive: true });
  canvas.saveAs(opts.outPng);
  return { png: opts.outPng, lines: [`sheet ${cols} panels (${["untouched", ...opts.variants.map((v) => v.label)].join(" | ")}) -> ${opts.outPng}`] };
}
