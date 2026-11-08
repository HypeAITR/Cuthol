import { FIXTURES_DIR } from "./fixtures.js";
/**
 * Font-dependent measurement inside document.fonts.ready, on render, monitor frame,
 * and composition preview. Also checks a transparent VP9 webm used as a clip:
 * alpha survives, and a file shorter than the scene holds its last frame.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");
const FONT_SRC = path.join(
  FIXTURES_DIR,
  "gfx_O/compositions/seg1/assets/fonts/inter-latin-wght-normal.woff2"
);
const STAGE = 1080;
const BACKDROP = "#2030C0";

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for the assertion message
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 4000) + (proc.stderr ?? "").slice(0, 1500),
  };
}

function run(cmd: string, args: string[]): void {
  const proc = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(
    proc.status,
    0,
    `${cmd} ${args.slice(0, 6).join(" ")} failed\n${proc.stderr ?? ""}\n${proc.stdout ?? ""}`.slice(0, 2000)
  );
}

interface Rgba {
  w: number;
  h: number;
  b: Buffer;
}

function loadRgba(file: string): Rgba {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  const [w, h] = String(probe.stdout).trim().split(",").map(Number);
  assert.ok(w > 0 && h > 0, `no dimensions for ${file}: ${probe.stdout} ${probe.stderr}`);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(decoded.status, 0, `decode ${file}: ${decoded.stderr?.toString?.() ?? ""}`);
  const b = decoded.stdout as Buffer;
  assert.equal(b.length, w * h * 4, `short decode ${file}: ${b.length}`);
  return { w, h, b };
}

function extractFrame(mp4: string, atSec: number, png: string): void {
  run("ffmpeg", ["-y", "-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", png]);
}

type Pred = (r: number, g: number, b: number, a: number) => boolean;

/**
 * Widest horizontal span of matching pixels on one row. Gaps up to `maxGap`
 * stay inside the span, so glyph holes in the title box count as part of its
 * width. The gap between contact-sheet columns is much wider and starts a new span.
 */
function widestRun(img: Rgba, pred: Pred, maxGap = 40): number {
  let best = 0;
  for (let y = 0; y < img.h; y++) {
    let start = -1;
    let last = -1;
    let gap = 0;
    const close = () => {
      if (start >= 0 && last >= start) {
        const span = last - start + 1;
        if (span > best) best = span;
      }
      start = -1;
      last = -1;
      gap = 0;
    };
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (pred(img.b[i], img.b[i + 1], img.b[i + 2], img.b[i + 3])) {
        if (start < 0) start = x;
        last = x;
        gap = 0;
      } else if (start >= 0) {
        gap++;
        if (gap > maxGap) close();
      }
    }
    close();
  }
  return best;
}

const isGreen: Pred = (r, g, b, a) => a > 200 && g > 170 && r < 100 && b < 100;
const isMagenta: Pred = (r, g, b, a) => a > 200 && r > 170 && b > 170 && g < 100;
const isRed: Pred = (r, g, b, a) => a > 200 && r > 170 && g < 90 && b < 90;
const isYellow: Pred = (r, g, b, a) => a > 200 && r > 170 && g > 170 && b < 90;
const isBackdrop: Pred = (r, g, b, a) => a > 200 && b > 140 && r < 90 && g < 110;

function measureBars(png: string): { title: number; line: number } {
  const img = loadRgba(png);
  return { title: widestRun(img, isGreen), line: widestRun(img, isMagenta) };
}

function assertBarsMatch(label: string, png: string): { title: number; line: number } {
  const bars = measureBars(png);
  const tol = Math.max(6, Math.round(bars.title * 0.04));
  assert.ok(bars.title > 40, `${label} title run ${bars.title} in ${png}`);
  assert.ok(
    Math.abs(bars.line - bars.title) <= tol,
    `${label} line ${bars.line}px vs title ${bars.title}px (tol ${tol}) in ${png}`
  );
  return bars;
}

function placeScript(waitForFonts: boolean): string {
  const body = `
    var title = document.getElementById("title");
    var measured = title.getBoundingClientRect().width;
    var transform = getComputedStyle(document.getElementById("root")).transform;
    var match = /matrix\\(([^)]+)\\)/.exec(transform || "");
    var scale = match ? parseFloat(match[1].split(",")[0]) || 1 : 1;
    document.getElementById("rule").style.width = (measured / scale) + "px";
    var C = window.__cuthol;
    var tl = gsap.timeline({ paused: true });
    tl.set({}, {}, C.duration);
    window.__timelines = window.__timelines || {};
    window.__timelines["main"] = tl;
  `;
  if (waitForFonts) {
    return `document.fonts.ready.then(function () {${body}});`;
  }
  return `(function () {${body}})();`;
}

function fontHtml(waitForFonts: boolean): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      @font-face {
        font-family: "MeasureFace";
        src: url("assets/inter-latin-wght-normal.woff2") format("woff2");
        font-weight: 100 900;
        font-style: normal;
        font-display: block;
        size-adjust: 200%;
      }
      html, body { margin: 0; background: transparent; }
      #root { position: relative; width: ${STAGE}px; height: ${STAGE}px; overflow: hidden; background: transparent; }
      #slot { position: absolute; left: 48px; top: 320px; }
      #title {
        display: inline-block;
        margin: 0;
        padding: 12px 0;
        font-family: "MeasureFace", sans-serif;
        font-weight: 800;
        font-size: 64px;
        line-height: 1;
        white-space: nowrap;
        color: #003000;
        background: #00ff00;
      }
      #rule { height: 24px; margin-top: 16px; background: #ff00ff; width: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0"
         data-width="${STAGE}" data-height="${STAGE}" data-fps="30" data-duration="1">
      <section class="clip" data-start="0" data-duration="1" data-track-index="0">
        <div id="slot">
          <div id="title">MMMM</div>
          <div id="rule"></div>
        </div>
      </section>
    </div>
    <script>
      ${placeScript(waitForFonts)}
    </script>
  </body>
</html>
`;
}

function webmHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>
      html, body { margin: 0; background: transparent; }
      #root { position: relative; width: ${STAGE}px; height: ${STAGE}px; overflow: hidden; background: transparent; }
      #mark { position: absolute; inset: 0; width: ${STAGE}px; height: ${STAGE}px; object-fit: fill; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0"
         data-width="${STAGE}" data-height="${STAGE}" data-fps="30" data-duration="2">
      <video id="mark" class="clip" src="assets/mark.webm" data-start="0" data-duration="2" data-track-index="0" muted playsinline></video>
    </div>
    <script>
      var C = window.__cuthol;
      var tl = gsap.timeline({ paused: true });
      tl.set({}, {}, C.duration);
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

function writeAlphaWebm(outFile: string): void {
  const half = STAGE / 2;
  const geq = [
    `r='if(lt(X,${half}),if(lt(T,0.2),255,if(lt(T,0.4),0,255)),0)'`,
    `g='if(lt(X,${half}),if(gte(T,0.4),255,0),0)'`,
    `b='if(lt(X,${half}),if(gte(T,0.2)*lt(T,0.4),255,0),0)'`,
    `a='if(lt(X,${half}),255,0)'`,
  ].join(":");
  run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${STAGE}x${STAGE}:r=30:d=0.6,format=rgba,geq=${geq}`,
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    "-b:v",
    "0",
    "-crf",
    "12",
    "-an",
    outFile,
  ]);
  const tags = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-show_entries", "stream_tags=alpha_mode", "-of", "default=nw=1", outFile],
    { encoding: "utf8" }
  ).stdout;
  assert.match(tags, /alpha_mode=1/, tags);
}

/**
 * Rows are classified by the opaque half so a contact sheet that stacks the early
 * and late samples still reports each phase. Backdrop pixels are counted only on
 * those rows (the clear half of the webm).
 */
function webmBands(img: Rgba): { red: number; yellow: number; backdropOnRed: number; backdropOnYellow: number } {
  let red = 0;
  let yellow = 0;
  let backdropOnRed = 0;
  let backdropOnYellow = 0;
  for (let y = 0; y < img.h; y++) {
    let rowRed = 0;
    let rowYellow = 0;
    let rowBackdrop = 0;
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const r = img.b[i];
      const g = img.b[i + 1];
      const b = img.b[i + 2];
      const a = img.b[i + 3];
      if (isRed(r, g, b, a)) rowRed++;
      else if (isYellow(r, g, b, a)) rowYellow++;
      else if (isBackdrop(r, g, b, a)) rowBackdrop++;
    }
    if (rowRed > 20 && rowRed > rowYellow * 3) {
      red += rowRed;
      backdropOnRed += rowBackdrop;
    } else if (rowYellow > 20 && rowYellow > rowRed * 3) {
      yellow += rowYellow;
      backdropOnYellow += rowBackdrop;
    }
  }
  return { red, yellow, backdropOnRed, backdropOnYellow };
}

function assertWebmFrame(
  label: string,
  png: string,
  expect: { early: boolean; late: boolean }
): { red: number; yellow: number; backdropOnRed: number; backdropOnYellow: number } {
  const bands = webmBands(loadRgba(png));
  if (expect.early) {
    assert.ok(bands.red > 1000, `${label} expected the red opening frame, ${JSON.stringify(bands)}`);
    assert.ok(bands.backdropOnRed > 500, `${label} clear half of the red frame should show the backdrop, ${JSON.stringify(bands)}`);
  } else {
    assert.ok(bands.red < 200, `${label} red opening frame still present, ${JSON.stringify(bands)}`);
  }
  if (expect.late) {
    assert.ok(bands.yellow > 1000, `${label} expected the yellow last frame, ${JSON.stringify(bands)}`);
    assert.ok(
      bands.backdropOnYellow > 500,
      `${label} clear half of the held frame should show the backdrop, ${JSON.stringify(bands)}`
    );
  } else {
    assert.ok(bands.yellow < 200, `${label} yellow last frame still present, ${JSON.stringify(bands)}`);
  }
  return bands;
}

test("fonts.ready underline matches the title, and a short alpha webm holds its last frame", { timeout: 900_000, skip: fs.existsSync(FONT_SRC) ? false : `fixture not present: ${FONT_SRC}` }, () => {
  const wsDir = path.join(TEST_ROOT, "fonts_ready");
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
  const backdrop = cli(["workspace", "backdrop", "--color", BACKDROP, "--dir", wsDir]);
  assert.ok(backdrop.ok, backdrop.raw);

  const readyDir = path.join(wsDir, "compositions", "fonts_ready");
  const syncDir = path.join(wsDir, "compositions", "fonts_sync");
  const webmDir = path.join(wsDir, "compositions", "alpha_webm");
  for (const [dir, dur] of [
    [readyDir, "1s"],
    [syncDir, "1s"],
    [webmDir, "2s"],
  ] as const) {
    const scaffold = cli(["composition", "scaffold", "--comp-dir", dir, "--preset", "blank", "--duration", dur, "--dir", wsDir]);
    assert.ok(scaffold.ok, scaffold.raw);
  }
  fs.copyFileSync(FONT_SRC, path.join(readyDir, "assets", "inter-latin-wght-normal.woff2"));
  fs.copyFileSync(FONT_SRC, path.join(syncDir, "assets", "inter-latin-wght-normal.woff2"));
  fs.writeFileSync(path.join(readyDir, "index.html"), fontHtml(true), "utf8");
  fs.writeFileSync(path.join(syncDir, "index.html"), fontHtml(false), "utf8");
  writeAlphaWebm(path.join(webmDir, "assets", "mark.webm"));
  fs.writeFileSync(path.join(webmDir, "index.html"), webmHtml(), "utf8");

  const mount = (id: string, dir: string, at: string, duration: string) => {
    const res = cli([
      "lane",
      "add-composition",
      "--lane",
      "ln_motion",
      "--id",
      id,
      "--comp-dir",
      dir,
      "--at",
      at,
      "--duration",
      duration,
      "--dir",
      wsDir,
    ]);
    assert.ok(res.ok, res.raw);
  };
  mount("fonts_ready", readyDir, "0ms", "1000ms");
  mount("fonts_sync", syncDir, "1000ms", "1000ms");
  mount("alpha_webm", webmDir, "2000ms", "2000ms");

  const shots = path.join(wsDir, "shots");
  fs.mkdirSync(shots, { recursive: true });

  // Monitor frame before render, so this path captures its own snapshot rather than a cached blob.
  const monitorReady = cli(["monitor", "frame", "--at", "400ms", "--boxes", "false", "--out", "shots/monitor_ready.png", "--dir", wsDir]);
  assert.ok(monitorReady.ok, monitorReady.raw);
  const monitorReadyBars = assertBarsMatch("monitor fonts.ready", path.join(wsDir, "shots", "monitor_ready.png"));

  const render = cli(["render", "--preset", "draft_480p", "--out", "output/fonts.mp4", "--dir", wsDir]);
  assert.ok(render.ok, render.raw);
  const mp4 = path.join(wsDir, "output", "fonts.mp4");

  const renderShots: Record<string, string> = {
    ready: path.join(shots, "render_ready.png"),
    sync: path.join(shots, "render_sync.png"),
    webmEarly: path.join(shots, "render_webm_early.png"),
    webmLate: path.join(shots, "render_webm_late.png"),
  };
  extractFrame(mp4, 0.4, renderShots.ready);
  extractFrame(mp4, 1.4, renderShots.sync);
  extractFrame(mp4, 2.1, renderShots.webmEarly);
  extractFrame(mp4, 3.7, renderShots.webmLate);
  const renderReadyBars = assertBarsMatch("render fonts.ready", renderShots.ready);
  const renderSyncBars = assertBarsMatch("render fonts.sync", renderShots.sync);
  const renderWebmEarly = assertWebmFrame("render early", renderShots.webmEarly, { early: true, late: false });
  const renderWebmLate = assertWebmFrame("render late", renderShots.webmLate, { early: false, late: true });

  const monitorSync = cli(["monitor", "frame", "--at", "1400ms", "--boxes", "false", "--out", "shots/monitor_sync.png", "--dir", wsDir]);
  assert.ok(monitorSync.ok, monitorSync.raw);
  const monitorWebmEarly = cli(["monitor", "frame", "--at", "2100ms", "--boxes", "false", "--out", "shots/monitor_webm_early.png", "--dir", wsDir]);
  assert.ok(monitorWebmEarly.ok, monitorWebmEarly.raw);
  const monitorWebmLate = cli(["monitor", "frame", "--at", "3700ms", "--boxes", "false", "--out", "shots/monitor_webm_late.png", "--dir", wsDir]);
  assert.ok(monitorWebmLate.ok, monitorWebmLate.raw);
  const monitorSyncBars = assertBarsMatch("monitor fonts.sync", path.join(wsDir, "shots", "monitor_sync.png"));
  const monitorWebmEarlyPx = assertWebmFrame("monitor early", path.join(wsDir, "shots", "monitor_webm_early.png"), { early: true, late: false });
  const monitorWebmLatePx = assertWebmFrame("monitor late", path.join(wsDir, "shots", "monitor_webm_late.png"), { early: false, late: true });

  const previewReady = cli(["composition", "preview", "--cue", "fonts_ready", "--at", "0.4", "--out", "shots/preview_ready.png", "--dir", wsDir]);
  assert.equal(previewReady.result?.ok, true, previewReady.raw);
  const previewSync = cli(["composition", "preview", "--cue", "fonts_sync", "--at", "0.4", "--out", "shots/preview_sync.png", "--dir", wsDir]);
  assert.equal(previewSync.result?.ok, true, previewSync.raw);
  const previewWebm = cli(["composition", "preview", "--cue", "alpha_webm", "--at", "0.1,1.7", "--out", "shots/preview_webm.png", "--dir", wsDir]);
  assert.equal(previewWebm.result?.ok, true, previewWebm.raw);
  const previewReadyBars = assertBarsMatch("preview fonts.ready", path.join(wsDir, "shots", "preview_ready.png"));
  const previewSyncBars = assertBarsMatch("preview fonts.sync", path.join(wsDir, "shots", "preview_sync.png"));
  const previewWebmPx = assertWebmFrame("preview", path.join(wsDir, "shots", "preview_webm.png"), { early: true, late: true });

  console.log(
    "FONTS_READY_MEASUREMENTS " +
      JSON.stringify({
        render: { ready: renderReadyBars, sync: renderSyncBars, webmEarly: renderWebmEarly, webmLate: renderWebmLate },
        monitor: {
          ready: monitorReadyBars,
          sync: monitorSyncBars,
          webmEarly: monitorWebmEarlyPx,
          webmLate: monitorWebmLatePx,
        },
        preview: { ready: previewReadyBars, sync: previewSyncBars, webm: previewWebmPx },
      })
  );
});
