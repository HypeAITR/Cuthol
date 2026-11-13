/**
 * Live render-free preview (`src/test/live_preview.test.ts`).
 *
 * Covers the preview pipeline end to end on an isolated copy of the live demo
 * project: proxy generation (codec/size/GOP/cache/queue), the composition file
 * endpoint, the exact-frame endpoint, and the window region in headless Chrome
 * (6-timestamp accuracy table vs `monitor frame` + the coordinate engine,
 * playback performance with proxies, delta resilience, zero console errors).
 *
 * The live server file belongs to another agent, so the test boots the real
 * `live serve` subprocess and wraps it with the preview handlers exactly as
 * the server file will mount them (see the endpoint contracts in
 * live_proxy.ts, live_comp_serve.ts and live_frame.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { loadSequence } from "../core/workspace.js";
import { routeLiveCompRequest } from "../live/live_comp_serve.js";
import { routeLiveFrameRequest } from "../live/live_frame.js";
import { LiveProxyManager, routeProxyRequest } from "../live/live_proxy.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = path.join(REPO, "test-workspace", "live-design", "fixture", "live_demo");
/** The demo project is a development fixture; the public repository skips these tests. */
const FIXTURE_SKIP = fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`;
const FRAME_MS = 1000 / 30;

function cli(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    timeout: 120000,
  });
  return { status: proc.status ?? 1, stdout: String(proc.stdout ?? ""), stderr: String(proc.stderr ?? "") };
}

function ffprobeJson(file: string, args: string[]): any {
  const proc = spawnSync("ffprobe", ["-v", "error", ...args, file], { encoding: "utf8", timeout: 60000 });
  assert.equal(proc.status, 0, `ffprobe failed: ${proc.stderr}`);
  return JSON.parse(proc.stdout);
}

/** Wait until `fn` returns truthy (poll 250 ms) or throw after `timeoutMs`. */
async function waitFor<T>(fn: () => T | Promise<T> | null | undefined | false, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Fixture {
  dir: string;
  token: string;
  port: number;
  live: ChildProcess;
  wrapPort: number;
  wrap: http.Server;
  manager: LiveProxyManager;
  proxyEvents: Array<{ handle: string; status: string; progress: number }>;
  url: (p: string) => string;
  seqHashBefore: string;
}

async function startFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-preview-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const live = spawn(process.execPath, [CLI, "live", "serve", "--dir", dir], {
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    stdio: "ignore",
    windowsHide: true,
  });
  const serverFile = path.join(dir, ".cuthol", "live", "server.json");
  await waitFor(() => fs.existsSync(serverFile), 20000, "live server.json");
  const info = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { port: number; token: string };
  const proxyEvents: Fixture["proxyEvents"] = [];
  const manager = new LiveProxyManager(dir, (event, data) => {
    proxyEvents.push({ handle: data.handle, status: data.status, progress: data.progress });
  });
  const wrap = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const tok = url.searchParams.get("t") ?? req.headers["x-cuthol-live-token"];
    // Iframe sub-resources carry no token; their Referer is the /comp/<cue>/?t= URL.
    let refTok: string | null = null;
    try {
      const ref = req.headers.referer;
      if (ref && url.pathname.startsWith("/comp/")) refTok = new URL(ref).searchParams.get("t");
    } catch {}
    const isData =
      url.pathname === "/events" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/media/") ||
      url.pathname.startsWith("/comp/");
    if (isData && tok !== info.token && refTok !== info.token) {
      res.writeHead(403).end("forbidden");
      return;
    }
    (async () => {
      if (url.pathname.startsWith("/api/proxy/")) {
        const handle = decodeURIComponent(url.pathname.slice("/api/proxy/".length));
        if (await routeProxyRequest(manager, req, res, handle)) return;
      }
      if (url.pathname.startsWith("/comp/")) {
        const rest = decodeURIComponent(url.pathname.slice("/comp/".length));
        const slash = rest.indexOf("/");
        const cueId = slash < 0 ? rest : rest.slice(0, slash);
        const sub = slash < 0 ? "/" : rest.slice(slash);
        if (routeLiveCompRequest(dir, req, res, cueId, sub)) return;
      }
      if (url.pathname === "/api/frame") {
        if (routeLiveFrameRequest(dir, req, res, Number(url.searchParams.get("at")))) return;
      }
      const proxy = http.request(
        { host: "127.0.0.1", port: info.port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${info.port}` } },
        (pres) => {
          res.writeHead(pres.statusCode ?? 500, pres.headers);
          pres.pipe(res);
        }
      );
      proxy.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502).end(String(e));
      });
      req.pipe(proxy);
    })().catch((e) => {
      if (!res.headersSent) res.writeHead(500).end(String(e?.stack ?? e));
    });
  });
  await new Promise<void>((r) => wrap.listen(0, "127.0.0.1", () => r()));
  const wrapPort = (wrap.address() as { port: number }).port;
  const seqHashBefore = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, "cuthol.sequence.json"))).digest("hex");
  return {
    dir,
    token: info.token,
    port: info.port,
    live,
    wrapPort,
    wrap,
    manager,
    proxyEvents,
    url: (p: string) => `http://127.0.0.1:${wrapPort}${p}${p.includes("?") ? "&" : "?"}t=${info.token}`,
    seqHashBefore,
  };
}

async function stopFixture(fx: Fixture): Promise<void> {
  fx.manager.shutdown();
  await new Promise<void>((r) => fx.wrap.close(() => r()));
  fx.live.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {}
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

test("live preview: proxies encode with the right shape, cache and progress", { skip: FIXTURE_SKIP }, async () => {
  const fx = await startFixture();
  try {
    // Smallest asset first (fast encode); the big one later proves 202 + queueing.
    fx.manager.ensure("vid_04");
    const ready = await waitFor(() => {
      const st = fx.manager.status("vid_04");
      return st.status === "ready" ? st : null;
    }, 240000, "vid_04 proxy");
    assert.ok(ready.file && fs.existsSync(ready.file), "proxy file exists");
    assert.ok(ready.file!.startsWith(path.join(fx.dir, ".cuthol", "live", "proxies")), "proxy lives under .cuthol/live/proxies");

    const streams = ffprobeJson(ready.file!, ["-show_entries", "stream=codec_name,width,height", "-of", "json"]).streams;
    const video = streams.find((s: any) => s.width > 0);
    assert.equal(video.codec_name, "h264");
    assert.equal(Math.min(video.width, video.height), 540, `short side is 540 (got ${video.width}x${video.height})`);
    const srcStreams = ffprobeJson(
      (loadSequence(fx.dir).sequence as any).library.find((a: any) => a.handle === "vid_04").uri,
      ["-show_entries", "stream=codec_type", "-of", "json"]
    ).streams;
    if (srcStreams.some((s: any) => s.codec_type === "audio")) {
      const audio = streams.find((s: any) => s.codec_name === "aac");
      assert.ok(audio, "proxy keeps AAC audio");
    }

    // Short GOP: every keyframe gap ~0.5 s (VFR tolerance 0.75 s).
    const kf = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "packet=pts_time", "-of", "csv=p=0", ready.file!],
      { encoding: "utf8", timeout: 60000 }
    );
    assert.equal(kf.status, 0);
    const times = String(kf.stdout).split(/\r?\n/).map(Number).filter(Number.isFinite);
    assert.ok(times.length >= 2, "proxy has several keyframes");
    let maxGap = 0;
    for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, times[i] - times[i - 1]);
    assert.ok(maxGap <= 0.75, `keyframe gap ${maxGap.toFixed(2)}s <= 0.75s`);

    // Cache: same content hash, no re-encode.
    const mtimeBefore = fs.statSync(ready.file!).mtimeMs;
    const again = fx.manager.ensure("vid_04");
    assert.equal(again.status, "ready");
    assert.equal(again.file, ready.file);
    assert.equal(fs.statSync(ready.file!).mtimeMs, mtimeBefore, "cached proxy is not re-encoded");

    // Progress events flowed through the `proxy` SSE payload shape.
    const evts = fx.proxyEvents.filter((e) => e.handle === "vid_04").map((e) => e.status);
    assert.ok(evts.includes("queued") || evts.includes("encoding"), `proxy events observed (${evts.join(",")})`);
    assert.ok(evts.includes("ready"), "ready event observed");

    // The sequence on disk is untouched by proxy generation (render plan identical).
    const after = crypto.createHash("sha1").update(fs.readFileSync(path.join(fx.dir, "cuthol.sequence.json"))).digest("hex");
    assert.equal(after, fx.seqHashBefore, "proxy generation never writes the sequence");

    // Route: ready proxy serves bytes with Range; unknown handle 404s.
    const full = await httpGet(fx.url("/api/proxy/vid_04"));
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.ok(full.body.length > 100000, "proxy body is a real file");
    const ranged = await httpGet(fx.url("/api/proxy/vid_04"), { Range: "bytes=0-99" });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.body.length, 100);
    const missing = await httpGet(fx.url("/api/proxy/nope_99"));
    assert.equal(missing.status, 404);
  } finally {
    await stopFixture(fx);
  }
});

test("live preview: big asset reports 202 while queued/encoding (max 1 at a time)", { skip: FIXTURE_SKIP }, async () => {
  const fx = await startFixture();
  try {
    fx.manager.ensure("vid_04");
    const st1 = fx.manager.ensure("vid_01");
    assert.ok(st1.status === "queued" || st1.status === "encoding", `vid_01 starts queued/encoding (got ${st1.status})`);
    const res = await httpGet(fx.url("/api/proxy/vid_01?status=1"));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body.toString("utf8"));
    assert.ok(body.status === "queued" || body.status === "encoding", `status endpoint mirrors queue (${body.status})`);
    const direct = await httpGet(fx.url("/api/proxy/vid_01"));
    assert.equal(direct.status, 202, "unready proxy answers 202 + status so the window falls back to /media");
    assert.ok(direct.headers["content-type"]?.includes("application/json"));
  } finally {
    await stopFixture(fx);
  }
});

test("live preview: composition files are served confined to the cue dir", { skip: FIXTURE_SKIP }, async () => {
  const fx = await startFixture();
  try {
    const entry = await httpGet(fx.url("/comp/cue_02/"));
    assert.equal(entry.status, 200);
    assert.ok(entry.headers["content-type"]?.includes("text/html"));
    const html = entry.body.toString("utf8");
    assert.ok(html.includes("__timelines=window.__timelines||{}"), "entry carries the extractor bootstrap");
    assert.ok(html.includes("main-banner"), "entry is the composition page");

    const asset = await httpGet(fx.url("/comp/cue_02/assets/gsap.min.js"));
    assert.equal(asset.status, 200);
    assert.ok(asset.body.length > 10000, "composition asset served");

    const traversal = await httpGet(fx.url("/comp/cue_02/../../../../cuthol.sequence.json"));
    assert.ok(traversal.status === 403 || traversal.status === 404, `traversal blocked (${traversal.status})`);

    const unknown = await httpGet(fx.url("/comp/cue_99/"));
    assert.equal(unknown.status, 404);
    assert.ok(JSON.parse(unknown.body.toString("utf8")).diagnostic.code === "CUTHOL-G611");
  } finally {
    await stopFixture(fx);
  }
});

test("live preview: exact frame renders the monitor frame as PNG", { skip: FIXTURE_SKIP }, async () => {
  const fx = await startFixture();
  try {
    const t0 = Date.now();
    const res = await httpGet(fx.url("/api/frame?at=2500"));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.deepEqual([...res.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.ok(res.body.length > 50000, `frame is a real render (${res.body.length} bytes in ${Date.now() - t0} ms)`);
    const bad = await httpGet(fx.url("/api/frame?at=-5"));
    assert.equal(bad.status, 400);
  } finally {
    await stopFixture(fx);
  }
});

interface PreviewState {
  t: number;
  duration: number;
  clipId: string | null;
  sourceMs: number | null;
  videoTimeMs: number;
  videoSrc: string;
  comps: string[];
  caption: string | null;
  activeWord: string | null;
  approx: boolean;
  playing: boolean;
}

async function openPreview(fx: Fixture): Promise<{ browser: Browser; page: Page; errors: string[] }> {
  const browser = await puppeteer.launch({
    executablePath: resolveCoordsChromePath(),
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("requestfailed", (r) => {
    if (r.failure()?.errorText === "net::ERR_ABORTED") return; // video src swap aborts in-flight ranges
    errors.push(`requestfailed: ${r.url().slice(0, 160)} ${r.failure()?.errorText}`);
  });
  await page.goto(fx.url("/"), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => (window as any).__livePreview, { timeout: 30000 });
  await page.waitForFunction(() => ((window as any).__livePreview.state().duration ?? 0) > 0, { timeout: 30000 });
  return { browser, page, errors };
}

async function previewState(page: Page): Promise<PreviewState> {
  return (await page.evaluate(() => (window as any).__livePreview.state())) as PreviewState;
}

/** Seek and wait until the video settles within ~1 frame of the mapped source time. */
async function seekSettled(page: Page, t: number): Promise<PreviewState> {
  await page.evaluate((ms: number) => {
    (window as any).__livePreview.seek(ms);
  }, t);
  const deadline = Date.now() + 8000;
  let last: PreviewState = await previewState(page);
  for (;;) {
    last = await previewState(page);
    if (last.sourceMs != null && Math.abs(last.videoTimeMs - last.sourceMs) <= FRAME_MS + 7) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Coordinate-engine box (stage px) for one element at a sequence timestamp. */
function coordsBox(dir: string, cue: string, atMs: number, key: string): [number, number, number, number] {
  const proc = cli(dir, ["composition", "coords", "--cue", cue, "--at", `${atMs}ms`]);
  assert.equal(proc.status, 0, `coords query failed: ${proc.stderr.slice(0, 400)}`);
  const payload = JSON.parse(proc.stdout);
  const el = (payload.elements as Array<{ key: string; item: [number, number, number, number] }>).find((e) => e.key === key);
  assert.ok(el, `element ${key} measured at ${atMs}ms`);
  return el!.item;
}

async function iframeBox(page: Page, cueId: string, elementId: string): Promise<[number, number, number, number] | null> {
  return await page.evaluate(
    ({ cue, id }: { cue: string; id: string }) => {
      const frame = document.querySelector(".pv-comp-frame") as HTMLIFrameElement | null;
      if (!frame?.contentWindow) return null;
      const el = frame.contentWindow.document.getElementById(id) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      void cue;
      return [r.x, r.y, r.width, r.height] as [number, number, number, number];
    },
    { cue: cueId, id: elementId }
  );
}

test("live preview: window accuracy at 6 timestamps (spine, comps, captions)", { skip: FIXTURE_SKIP, timeout: 600000 }, async () => {
  const fx = await startFixture();
  // Encode the big proxy in the background while accuracy runs on media fallback.
  fx.manager.ensure("vid_01");
  const { browser, page, errors } = await openPreview(fx);
  try {
    const rows: Array<{
      t: number;
      clip: string | null;
      source: number | null;
      comps: string[];
      caption: string | null;
      word: string | null;
      compKey?: string;
    }> = [
      { t: 500, clip: "sp_01", source: 500, comps: [], caption: null, word: null },
      { t: 2500, clip: "sp_01", source: 2500, comps: ["cue_02"], caption: "cue_05", word: "Bugün", compKey: "main-banner" },
      { t: 13990, clip: "sp_01", source: 13990, comps: [], caption: "cue_12", word: null },
      { t: 14010, clip: "sp_02", source: 10, comps: [], caption: null, word: null },
      { t: 21000, clip: "sp_03", source: 17000, comps: ["cue_03"], caption: "cue_15", word: null, compKey: "main-bar" },
      { t: 38300, clip: "sp_05", source: 30300, comps: [], caption: "cue_23", word: null },
    ];
    const table: string[] = ["t(ms) | expected clip/src | seen clip/src | Δframes | comps | caption/word | comp box Δpx"];
    for (const row of rows) {
      const seen = await seekSettled(page, row.t);
      assert.equal(seen.clipId, row.clip, `clip at ${row.t}ms`);
      assert.equal(seen.sourceMs, row.source, `mapped source at ${row.t}ms`);
      const driftFrames = row.source == null ? 0 : Math.abs(seen.videoTimeMs - row.source) / FRAME_MS;
      assert.ok(driftFrames <= 1, `video within ±1 frame at ${row.t}ms (Δ ${driftFrames.toFixed(2)}f)`);
      assert.deepEqual(seen.comps, row.comps, `comps at ${row.t}ms`);
      assert.equal(seen.caption, row.caption, `caption at ${row.t}ms`);
      if (row.word) assert.equal(seen.activeWord, row.word, `active word at ${row.t}ms`);
      let boxDelta = "-";
      if (row.compKey && row.comps.length > 0) {
        const engine = coordsBox(fx.dir, row.comps[0], row.t, row.compKey);
        const frame = await waitFor(async () => await iframeBox(page, row.comps[0], row.compKey!), 8000, `iframe box ${row.compKey}`);
        const perEdge = engine.map((v, i) => Math.abs(v - frame[i]));
        const max = Math.max(...perEdge);
        boxDelta = max.toFixed(1);
        assert.ok(max <= 4, `comp box within 4px at ${row.t}ms (Δ ${perEdge.map((d) => d.toFixed(1)).join("/")})`);
      }
      // The monitor-frame path agrees on the same timestamp (endpoint level).
      const exact = await httpGet(fx.url(`/api/frame?at=${row.t}`));
      assert.equal(exact.status, 200, `exact frame renders at ${row.t}ms`);
      table.push(
        `${row.t} | ${row.clip}/${row.source} | ${seen.clipId}/${seen.videoTimeMs} | ${driftFrames.toFixed(2)} | ${seen.comps.join(",") || "-"} | ${seen.caption ?? "-"}${seen.activeWord ? "/" + seen.activeWord : ""} | ${boxDelta}`
      );
    }
    console.log(`\npreview accuracy (demo copy):\n${table.join("\n")}\n`);
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopFixture(fx);
  }
});

test("live preview: proxy playback performance (1080p source, drops, heap, idle)", { skip: FIXTURE_SKIP, timeout: 600000 }, async () => {
  const fx = await startFixture();
  try {
    fx.manager.ensure("vid_01");
    await waitFor(() => {
      const st = fx.manager.status("vid_01");
      return st.status === "ready" ? st : null;
    }, 420000, "vid_01 proxy");
    const { browser, page, errors } = await openPreview(fx);
    try {
      await seekSettled(page, 5000);
      const st = await previewState(page);
      assert.ok(st.videoSrc.includes("/api/proxy/vid_01"), `playing the proxy, not the original (${st.videoSrc})`);
      const perf = await page.evaluate(async () => {
        const vis = [...document.querySelectorAll(".pv-video")].find(
          (v) => (v as HTMLVideoElement).style.visibility === "visible"
        ) as HTMLVideoElement;
        const q0 = vis.getVideoPlaybackQuality();
        const mem0 = (performance as any).memory?.usedJSHeapSize ?? 0;
        const t0 = performance.now();
        let raf = 0;
        await new Promise<void>((resolve) => {
          const loop = () => {
            raf++;
            if (performance.now() - t0 < 5000) requestAnimationFrame(loop);
            else resolve();
          };
          (window as any).__livePreview.play();
          requestAnimationFrame(loop);
        });
        (window as any).__livePreview.pause();
        const q1 = vis.getVideoPlaybackQuality();
        const mem1 = (performance as any).memory?.usedJSHeapSize ?? 0;
        // Idle main thread: count long frames while paused.
        let longFrames = 0;
        const idle0 = performance.now();
        let prev = idle0;
        await new Promise<void>((resolve) => {
          const loop = () => {
            const now = performance.now();
            if (now - prev > 100) longFrames++;
            prev = now;
            if (now - idle0 < 2000) requestAnimationFrame(loop);
            else resolve();
          };
          requestAnimationFrame(loop);
        });
        return {
          elapsedMs: performance.now() - t0,
          raf,
          presented: q1.totalVideoFrames - q0.totalVideoFrames,
          dropped: q1.droppedVideoFrames - q0.droppedVideoFrames,
          heapMB: mem1 / 1048576,
          heapDeltaMB: (mem1 - mem0) / 1048576,
          idleLongFrames: longFrames,
          endedAt: (window as any).__livePreview.state().t as number,
        };
      });
      const total = perf.presented + perf.dropped;
      const dropRate = total > 0 ? perf.dropped / total : 0;
      console.log(
        `\npreview perf (proxy, 5s from 5000ms): presented=${perf.presented} dropped=${perf.dropped} ` +
          `dropRate=${(dropRate * 100).toFixed(1)}% raf=${perf.raf} heap=${perf.heapMB.toFixed(1)}MB ` +
          `(Δ${perf.heapDeltaMB.toFixed(1)}MB) idleLongFrames=${perf.idleLongFrames} endedAt=${Math.round(perf.endedAt)}ms\n`
      );
      assert.ok(perf.presented > 60, `video advances during playback (${perf.presented} frames)`);
      assert.ok(perf.endedAt > 8000, `playhead advances with the clock (ended at ${Math.round(perf.endedAt)}ms)`);
      assert.ok(dropRate < 0.2, `drop rate under 20% in headless (${(dropRate * 100).toFixed(1)}%)`);
      assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
    } finally {
      await browser.close();
    }
  } finally {
    await stopFixture(fx);
  }
});

test("live preview: new revision renders at the same playhead without a flicker", { skip: FIXTURE_SKIP, timeout: 300000 }, async () => {
  const fx = await startFixture();
  const { browser, page, errors } = await openPreview(fx);
  try {
    await seekSettled(page, 2500);
    // A real agent-side edit through the CLI + journal (backdrop color).
    const edit = cli(fx.dir, ["workspace", "backdrop", "--color", "#14202e"]);
    assert.equal(edit.status, 0, `backdrop edit applies: ${edit.stderr.slice(0, 300)}`);
    // Wave-0 live_client does not map `delta` onto the store yet (server file
    // belongs to another agent), so the test feeds the fresh server snapshot
    // through the same intake the store handlers call.
    const applied = await page.evaluate(async () => {
      const hook = (window as any).__livePreview;
      const before = hook.state();
      const token = new URLSearchParams(location.search).get("t");
      const snap = await (await fetch(`/api/snapshot?t=${token}`)).json();
      hook.applySnapshot(snap);
      const after = hook.state();
      const bg = getComputedStyle(document.querySelector(".pv-stage") as HTMLElement).backgroundColor;
      return { beforeT: before.t, afterT: after.t, clip: after.clipId, bg };
    });
    assert.equal(applied.afterT, applied.beforeT, "playhead does not move on a new revision");
    assert.equal(applied.afterT, 2500, "still showing the same moment");
    assert.equal(applied.clip, "sp_01", "same clip after the revision");
    assert.equal(applied.bg, "rgb(20, 32, 46)", `new backdrop renders (${applied.bg})`);
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopFixture(fx);
  }
});
