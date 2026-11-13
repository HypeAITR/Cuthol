/**
 * Live preview media (`src/test/live_preview_media.test.ts`), on an isolated
 * copy of the live demo project: off-grid cue edges keep the ending cue
 * visible (frame-grid parity with render/monitor frame), the spine audio chain
 * on the <video> volume, stills never restart ended media, the exact-frame
 * loading indicator, the proxy progress strip plus the still-image fallback,
 * audio-only assets and the per-content-hash failure cache, and the hold at
 * the end of a cue longer than its composition.
 *
 * Window assertions run against the real `live serve` (no wrapper server);
 * proxy-manager assertions use LiveProxyManager directly on the copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { LiveProxyManager } from "../live/live_proxy.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = path.join(REPO, "test-workspace", "live-design", "fixture", "live_demo");
/** The demo project is a development fixture; the public repository skips these tests. */
const FIXTURE_SKIP = fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`;

function cli(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    timeout: 180000,
  });
  return { status: proc.status ?? 1, stdout: String(proc.stdout ?? ""), stderr: String(proc.stderr ?? "") };
}

async function waitFor<T>(fn: () => T | Promise<T> | null | undefined | false, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function httpGet(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

function freshCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-preview-media-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function readSequence(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8"));
}

function writeSequence(dir: string, seq: any): void {
  fs.writeFileSync(path.join(dir, "cuthol.sequence.json"), JSON.stringify(seq, null, 2));
}

interface Served {
  dir: string;
  proc: ChildProcess;
  pid: number;
  base: string;
  token: string;
  url: string;
  q: (p: string) => string;
}

async function startServer(dir: string): Promise<Served> {
  const proc = spawn(process.execPath, [CLI, "live", "serve", "--dir", dir], {
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    stdio: "ignore",
    windowsHide: true,
  });
  const serverFile = path.join(dir, ".cuthol", "live", "server.json");
  await waitFor(() => fs.existsSync(serverFile), 30000, "live server.json");
  const info = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { port: number; token: string; pid: number };
  const base = `http://127.0.0.1:${info.port}`;
  return {
    dir,
    proc,
    pid: info.pid,
    base,
    token: info.token,
    url: `${base}/?t=${info.token}`,
    q: (p: string) => `${base}${p}${p.includes("?") ? "&" : "?"}t=${info.token}`,
  };
}

async function stopServer(srv: Served): Promise<void> {
  // Kill the whole tree: the server may have ffmpeg encoders running and plain
  // kill() would orphan them onto a deleted directory.
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 });
    } else {
      srv.proc.kill("SIGKILL");
    }
  } catch {}
  try {
    srv.proc.kill("SIGKILL");
  } catch {}
  await new Promise((r) => setTimeout(r, 800));
  try {
    fs.rmSync(srv.dir, { recursive: true, force: true });
  } catch {}
}

async function openWindow(srv: Served): Promise<{ browser: Browser; page: Page; errors: string[] }> {
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
    if (r.failure()?.errorText === "net::ERR_ABORTED") return;
    errors.push(`requestfailed: ${r.url().slice(0, 160)} ${r.failure()?.errorText}`);
  });
  await page.goto(srv.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => (window as any).__livePreview, { timeout: 30000 });
  await page.waitForFunction(() => ((window as any).__livePreview.state().duration ?? 0) > 0, { timeout: 30000 });
  return { browser, page, errors };
}

async function previewComps(page: Page): Promise<string[]> {
  return (await page.evaluate(() => (window as any).__livePreview.state().comps)) as string[];
}

async function seek(page: Page, ms: number): Promise<void> {
  await page.evaluate((t: number) => (window as any).__livePreview.seek(t), ms);
}

/** Generate a small still image with ffmpeg (deterministic lavfi frame). */
function makeStillPng(file: string): void {
  const proc = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x2a4d69:s=640x360", "-frames:v", "1", file], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(proc.status, 0, `still generation failed: ${proc.stderr}`);
}

/** Ingest a file and return the allocated handle (diffed, not parsed). */
function ingestFile(dir: string, file: string): string {
  const before = new Set((readSequence(dir).library as any[]).map((a) => a.handle));
  const res = cli(dir, ["library", "ingest", file]);
  assert.equal(res.status, 0, `ingest failed: ${res.stderr.slice(0, 500)}`);
  const after = (readSequence(dir).library as any[]).map((a) => a.handle);
  const fresh = after.filter((h) => !before.has(h));
  assert.equal(fresh.length, 1, `one handle allocated (got ${fresh.join(",")})`);
  return fresh[0];
}

test("proxy: audio-only assets report terminal missing without spawning an encoder", { skip: FIXTURE_SKIP, timeout: 180000 }, async () => {
  const dir = freshCopy();
  try {
    const events: Array<{ status: string }> = [];
    const mgr = new LiveProxyManager(dir, (_event, data) => {
      if (data.handle === "aud_01") events.push({ status: data.status });
    });
    try {
      for (let i = 0; i < 3; i++) {
        const st = mgr.ensure("aud_01");
        assert.equal(st.status, "missing");
        assert.match(st.detail ?? "", /audio-only/);
      }
      assert.equal(mgr.status("aud_01").status, "missing");
      assert.ok(events.length > 0, "missing status is published");
      assert.ok(
        events.every((e) => e.status === "missing"),
        `audio handle never queues (events: ${events.map((e) => e.status).join(",")})`
      );
      const proxiesDir = path.join(dir, ".cuthol", "live", "proxies");
      const temps = fs.existsSync(proxiesDir)
        ? fs.readdirSync(proxiesDir).filter((f) => f.includes(".part-") || f.includes(".progress-"))
        : [];
      assert.deepEqual(temps, [], "no encoder temp files for the audio handle");
    } finally {
      mgr.shutdown();
    }
    // Same answer through the real server: JSON status, 404 bytes.
    const srv = await startServer(dir);
    try {
      const st = await httpGet(srv.q("/api/proxy/aud_01?status=1"));
      assert.equal(st.status, 200);
      assert.equal((JSON.parse(st.body.toString("utf8")) as any).status, "missing");
      const direct = await httpGet(srv.q("/api/proxy/aud_01"));
      assert.equal(direct.status, 404);
    } finally {
      await stopServer(srv);
    }
  } catch (e) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    throw e;
  }
});

test("proxy: failed encodes are remembered per content hash, a changed source retries", { skip: FIXTURE_SKIP, timeout: 180000 }, async () => {
  const dir = freshCopy();
  const mgrEvents: Array<{ status: string }> = [];
  const mgr = new LiveProxyManager(dir, (_event, data) => {
    if (data.handle === "bad_01") mgrEvents.push({ status: data.status });
  });
  try {
    // An empty file with a video probe: ffmpeg cannot fail to fail on it.
    const badFile = path.join(dir, "bad_01.mp4");
    fs.writeFileSync(badFile, Buffer.alloc(0));
    const seq = readSequence(dir);
    const template = (seq.library as any[]).find((a) => a.handle === "vid_04");
    (seq.library as any[]).push({ ...template, handle: "bad_01", uri: badFile });
    writeSequence(dir, seq);

    const first = mgr.ensure("bad_01");
    assert.ok(first.status === "queued" || first.status === "encoding", `first attempt runs (got ${first.status})`);
    const failed = await waitFor(() => {
      const st = mgr.status("bad_01");
      return st.status === "failed" ? st : null;
    }, 60000, "bad_01 failure");
    assert.match(failed.detail ?? "", /ffmpeg/);
    const attemptsBefore = mgrEvents.filter((e) => e.status === "queued" || e.status === "encoding").length;
    assert.ok(attemptsBefore > 0, "the failing job ran once");

    // Polling the status must not re-spawn ffmpeg for the same bytes.
    for (let i = 0; i < 3; i++) {
      const st = mgr.ensure("bad_01");
      assert.equal(st.status, "failed");
      assert.equal(st.detail, failed.detail);
    }
    await new Promise((r) => setTimeout(r, 2000));
    const attemptsAfter = mgrEvents.filter((e) => e.status === "queued" || e.status === "encoding").length;
    assert.equal(attemptsAfter, attemptsBefore, "no re-spawn for the same content hash");

    // A changed source (new hash) retries.
    fs.writeFileSync(badFile, Buffer.alloc(1024, 7));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(badFile, later, later);
    const retry = mgr.ensure("bad_01");
    assert.ok(retry.status === "queued" || retry.status === "encoding", `changed source retries (got ${retry.status})`);
    await waitFor(() => (mgr.status("bad_01").status === "failed" ? true : null), 60000, "bad_01 second failure");
  } finally {
    mgr.shutdown();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test("preview: an off-grid cue end keeps the ending cue visible, an on-grid end does not", { skip: FIXTURE_SKIP, timeout: 300000 }, async () => {
  const dir = freshCopy();
  // cue_02 [1000,5000] ends on the frame grid; push its end 5 ms off-grid.
  const seq = readSequence(dir);
  const cue02 = (seq.lanes as any[]).flatMap((l) => l.cues).find((c: any) => c.id === "cue_02");
  cue02.duration_ms = 4005;
  writeSequence(dir, seq);
  const srv = await startServer(dir);
  const { browser, page, errors } = await openWindow(srv);
  try {
    await seek(page, 5005);
    const comps = await waitFor(async () => {
      const c = await previewComps(page);
      return c.length > 0 ? c : null;
    }, 15000, "cue_02 at its off-grid end");
    assert.deepEqual(comps, ["cue_02"], "the ending cue stays visible at its off-grid end instant");
    // …rendered at its end state, not its empty entry.
    const tlTime = await waitFor(async () => {
      const t = await page.evaluate(() => {
        try {
          const f = document.querySelector(".pv-comp-frame") as HTMLIFrameElement | null;
          const tl = (f?.contentWindow as any)?.__timelines?.main;
          return typeof tl?.time === "function" ? tl.time() : null;
        } catch {
          return null;
        }
      });
      // The iframe loads asynchronously: only the converged end state counts.
      // The fixture comp declares data-duration 4 but its real timeline is
      // 0.67 s: the preview asks for the cue-local end and the timeline
      // clamps to its own end and holds — that held end state is the check.
      if (typeof t !== "number") return null;
      const d = await page.evaluate(() => {
        try {
          const f = document.querySelector(".pv-comp-frame") as HTMLIFrameElement | null;
          const tl = (f?.contentWindow as any)?.__timelines?.main;
          return typeof tl?.duration === "function" ? tl.duration() : null;
        } catch {
          return null;
        }
      });
      return typeof d === "number" && d > 0 && Math.abs(t - d) < 0.05 ? { time: t, duration: d } : null;
    }, 30000, "cue_02 end-state seek");
    assert.ok(Math.abs(tlTime.time - tlTime.duration) < 0.05, `ending cue holds its end state (got ${tlTime.time}/${tlTime.duration})`);

    // On-grid control: cue_03 [20000,25000] ends exactly on a frame; the new
    // instant belongs to whatever follows, not to the ending cue.
    await seek(page, 25000);
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(await previewComps(page), [], "no stale cue at an on-grid end instant");
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopServer(srv);
  }
});

test("preview: a cue longer than its composition holds the composition end state", { skip: FIXTURE_SKIP, timeout: 300000 }, async () => {
  const dir = freshCopy();
  // Shorten the composition under the cue so the overlong zone is observable.
  const compFile = path.join(dir, "comps", "title", "index.html");
  const html = fs.readFileSync(compFile, "utf8");
  assert.ok(html.includes('data-duration="4"'), "fixture comp exposes data-duration");
  fs.writeFileSync(compFile, html.replaceAll('data-duration="4"', 'data-duration="2"'));
  const srv = await startServer(dir);
  const { browser, page, errors } = await openWindow(srv);
  try {
    // A spy timeline records the exact seek time the preview asks for.
    await seek(page, 4000);
    await page.waitForFunction(() => document.querySelector(".pv-comp-frame"), { timeout: 15000 });
    const spySeeks = async (): Promise<number[]> =>
      (await page.evaluate(() => {
        const f = document.querySelector(".pv-comp-frame") as HTMLIFrameElement | null;
        const w = f?.contentWindow as any;
        if (!w) return [];
        w.__timelines = w.__timelines || {};
        if (!w.__timelines.__r3spy) {
          w.__timelines.__r3spy = {
            pause() {},
            seek(t: number) {
              (w.__r3spySeeks = w.__r3spySeeks || []).push(t);
            },
          };
        }
        return (w.__r3spySeeks || []) as number[];
      })) as number[];
    await seek(page, 4001); // re-seek through the spy (cue-local 3001 > comp 2000)
    const over = await waitFor(async () => {
      const s = await spySeeks();
      return s.length > 0 ? s : null;
    }, 15000, "spy seek in the overlong zone");
    assert.ok(
      over.every((t) => Math.abs(t - 2.0) < 0.001),
      `overlong zone seeks the comp end (got ${over.join(",")})`
    );
    await seek(page, 2500); // cue-local 1500 < comp 2000: unclamped
    await waitFor(async () => ((await spySeeks()).length > over.length ? true : null), 15000, "spy seek mid-cue");
    const mid = (await spySeeks()).slice(-1)[0];
    assert.ok(Math.abs(mid - 1.5) < 0.05, `mid-cue seeks stay exact (got ${mid})`);
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopServer(srv);
  }
});

test("preview: spine audio chain drives the video volume", { skip: FIXTURE_SKIP, timeout: 300000 }, async () => {
  const dir = freshCopy();
  const seq = readSequence(dir);
  for (const c of seq.spine.clips as any[]) {
    if (c.id === "sp_02") {
      c.audio_chain.muted = true;
      c.audio_chain.gain_db = 2.8;
    }
    if (c.id === "sp_03") c.audio_chain.gain_db = -6;
  }
  writeSequence(dir, seq);
  const srv = await startServer(dir);
  const { browser, page, errors } = await openWindow(srv);
  try {
    // A muted clip reports volume 0, which is falsy: propagate null only when
    // no visible video exists yet.
    const visibleVol = () =>
      page.evaluate(() => {
        const v = [...document.querySelectorAll(".pv-video")].find((x) => (x as HTMLVideoElement).style.visibility === "visible") as
          | HTMLVideoElement
          | undefined;
        return v ? v.volume : null;
      });
    await seek(page, 16000); // sp_02 [14000,18000], muted
    const mutedVol = await waitFor(async () => {
      const v = await visibleVol();
      return v === null ? null : { vol: v };
    }, 30000, "sp_02 video");
    assert.equal(mutedVol.vol, 0, "muted spine clip plays silent");
    await seek(page, 26000); // sp_03 [18000,34000], -6 dB
    const gainVol = await waitFor(async () => await visibleVol(), 15000, "sp_03 video");
    assert.ok(Math.abs((gainVol as number) - 0.501) < 0.03, `gain applied (got ${gainVol})`);
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopServer(srv);
  }
});

test("preview: a still never restarts its ended media while playing", { skip: FIXTURE_SKIP, timeout: 420000 }, async () => {
  const dir = freshCopy();
  const stillFile = path.join(dir, "r3_still.png");
  makeStillPng(stillFile);
  const handle = ingestFile(dir, stillFile);
  const beforeClips = new Set((readSequence(dir).spine.clips as any[]).map((c) => c.id));
  const append = cli(dir, ["spine", "append", "--asset", handle, "--out", "10s"]);
  assert.equal(append.status, 0, `still appends: ${append.stderr.slice(0, 300)}`);
  // A spine of only the still: its proxy encodes in seconds, not behind videos.
  const seq = readSequence(dir);
  const still = (seq.spine.clips as any[]).find((c) => !beforeClips.has(c.id));
  assert.ok(still, "appended still clip found");
  still.timeline_in_ms = 0;
  seq.spine.clips = [still];
  writeSequence(dir, seq);
  const srv = await startServer(dir);
  try {
    await waitFor(async () => {
      const res = await httpGet(srv.q(`/api/proxy/${handle}?status=1`));
      return (JSON.parse(res.body.toString("utf8")) as any).status === "ready" ? true : null;
    }, 240000, "still proxy");
    const { browser, page, errors } = await openWindow(srv);
    try {
      await seek(page, 1000);
      await page.evaluate(() => {
        (window as any).__r3plays = 0;
        for (const v of document.querySelectorAll(".pv-video") as unknown as HTMLVideoElement[]) {
          const orig = v.play.bind(v);
          v.play = (...a: []) => {
            (window as any).__r3plays++;
            return orig(...(a as []));
          };
        }
      });
      await page.evaluate(() => {
        (window as any).__r3plays = 0;
        (window as any).__livePreview.play();
      });
      await new Promise((r) => setTimeout(r, 8000));
      const res = await page.evaluate(() => {
        const v = [...document.querySelectorAll(".pv-video")].find(
          (x) => (x as HTMLVideoElement).style.visibility === "visible"
        ) as HTMLVideoElement;
        // Read the transport state before pausing: pause() itself clears it.
        const playing = (window as any).__livePreview.state().playing as boolean;
        (window as any).__livePreview.pause();
        return {
          plays: (window as any).__r3plays as number,
          paused: v.paused,
          currentTime: v.currentTime,
          duration: v.duration,
          playing,
        };
      });
      assert.equal(res.playing, true, "the window was playing while measuring");
      assert.ok(res.plays <= 2, `ended still is not restarted per tick (play calls: ${res.plays})`);
      assert.equal(res.paused, true, "ended media stays paused on its last frame");
      assert.ok(Math.abs(res.currentTime - res.duration) < 0.06, "frozen at the media end");
      assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
    } finally {
      await browser.close();
    }
  } finally {
    await stopServer(srv);
  }
});

test("preview: exact frame shows a loading indicator while rendering", { skip: FIXTURE_SKIP, timeout: 300000 }, async () => {
  const dir = freshCopy();
  const grade = cli(dir, ["spine", "grade", "--clip", "sp_01", "--brightness", "0.1"]);
  assert.equal(grade.status, 0, `grade applies: ${grade.stderr.slice(0, 300)}`);
  const srv = await startServer(dir);
  const { browser, page, errors } = await openWindow(srv);
  try {
    await seek(page, 1000);
    await new Promise((r) => setTimeout(r, 1000));
    const badge = await page.evaluate(() => ({
      badge: !(document.querySelector(".pv-badge") as HTMLElement).hidden,
      btn: !(document.querySelector(".pv-exact-btn") as HTMLElement).hidden,
    }));
    assert.ok(badge.badge && badge.btn, "graded clip raises the badge and the button");
    await page.evaluate(() => (document.querySelector(".pv-exact-btn") as HTMLButtonElement).click());
    const seen = await waitFor(async () => {
      const s = await page.evaluate(() => ({
        loading: !(document.querySelector(".pv-exact-loading") as HTMLElement).hidden,
        done: !(document.querySelector(".pv-exact-img") as HTMLElement).hidden,
      }));
      return s.loading || s.done ? s : null;
    }, 15000, "exact loading indicator");
    assert.ok(seen.loading, "loading indicator shows while the frame renders");
    await page.waitForFunction(() => !(document.querySelector(".pv-exact-img") as HTMLElement).hidden, { timeout: 60000 });
    const hidden = await page.evaluate(() => (document.querySelector(".pv-exact-loading") as HTMLElement).hidden);
    assert.ok(hidden, "loading indicator hides when the frame arrives");
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopServer(srv);
  }
});

test("preview: proxy progress strip and still fallback while proxies encode", { skip: FIXTURE_SKIP, timeout: 300000 }, async () => {
  const dir = freshCopy();
  const stillFile = path.join(dir, "r3_still.png");
  makeStillPng(stillFile);
  const handle = ingestFile(dir, stillFile);
  const append = cli(dir, ["spine", "append", "--asset", handle, "--out", "10s"]);
  assert.equal(append.status, 0, `still appends: ${append.stderr.slice(0, 300)}`);
  const still = (readSequence(dir).spine.clips as any[]).find((c) => c.asset_handle === handle);
  const stillMid = still.timeline_in_ms + Math.floor(still.duration_ms / 2);
  // Fresh boot: every proxy encodes, the still waits last in the FIFO queue.
  const srv = await startServer(dir);
  const { browser, page, errors } = await openWindow(srv);
  try {
    await seek(page, stillMid);
    // Cold boot queues status fetches behind thumbnail work: wait for the
    // strip instead of sampling it after a fixed sleep.
    const fallback = await waitFor(async () => {
      const f = await page.evaluate(() => ({
        strip: !(document.querySelector(".pv-proxy") as HTMLElement).hidden,
        text: (document.querySelector(".pv-proxy-text") as HTMLElement).textContent,
        stills: [...document.querySelectorAll(".pv-still")].map((i) => (i as HTMLElement).style.visibility),
        videos: [...document.querySelectorAll(".pv-video")].map((v) => (v as HTMLElement).style.visibility),
        proxies: (window as any).__livePreview.proxies(),
      }));
      return f.strip ? f : null;
    }, 60000, "proxy progress strip");
    assert.ok(fallback.strip, "progress strip shows while proxies encode");
    assert.match(fallback.text ?? "", /Preparing proxies/, `strip text (${fallback.text})`);
    assert.ok(fallback.stills.includes("visible"), "still image shows instead of black");
    assert.ok(fallback.videos.every((v) => v === "hidden"), "no black video under the fallback");
    // The strip renders before the status round trips finish: wait until the
    // still's status arrives, then require it to be pending (it sits last in
    // the FIFO behind minutes of video encoding).
    const stillStat = await waitFor(async () => {
      const st = (await page.evaluate(() => (window as any).__livePreview.proxies())) as {
        stat: Record<string, { status: string }>;
      };
      return st.stat[handle]?.status ?? null;
    }, 60000, "still proxy status");
    assert.ok(stillStat === "queued" || stillStat === "encoding", `still proxy pending (got ${stillStat})`);
    // Video clips without a proxy play the original media meanwhile.
    await seek(page, 2000);
    await new Promise((r) => setTimeout(r, 2000));
    const videoSrc = await page.evaluate(() => {
      const v = [...document.querySelectorAll(".pv-video")].find((x) => (x as HTMLElement).style.visibility === "visible") as
        | HTMLVideoElement
        | undefined;
      return v?.currentSrc ?? "";
    });
    assert.ok(videoSrc.includes("/media/"), `video falls back to original media (${videoSrc.slice(-40)})`);
    assert.deepEqual(errors, [], `zero console/page/network errors (got ${errors.length})`);
  } finally {
    await browser.close();
    await stopServer(srv);
  }
});
