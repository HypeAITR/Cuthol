import test from "node:test";
import assert from "node:assert/strict";
import { extendCompositionHtmlDuration, readCompositionTimelineSec } from "../compositor/hf_blobs.js";

const HTML = [
  `<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-fps="30" data-duration="4">`,
  `<section id="slot" class="clip" data-start="0" data-duration="4"></section>`,
  `<div id="mid" class="clip" data-start="1" data-duration="1"></div>`,
  `<div id="tail" class="clip" data-start="2.5" data-duration="1.5"></div>`,
  `</div>`,
].join("\n");

test("reads the composition's own timeline from its root", () => {
  assert.equal(readCompositionTimelineSec(HTML), 4);
  assert.equal(readCompositionTimelineSec(`<div data-composition-id='x' data-duration='2.5'></div>`), 2.5);
  assert.equal(readCompositionTimelineSec(`<div id="root"></div>`), null);
});

test("a longer cue stretches the root and every element that ran to the end; others stay", () => {
  const out = extendCompositionHtmlDuration(HTML, 4, 8, 30);
  assert.match(out, /data-composition-id="main"[^>]*data-duration="8"/);
  assert.match(out, /id="slot"[^>]*data-duration="8"/);
  assert.match(out, /id="mid"[^>]*data-duration="1"/);
  assert.match(out, /id="tail"[^>]*data-duration="5.5"/);
});

test("never shortens anything", () => {
  assert.equal(extendCompositionHtmlDuration(HTML, 4, 3, 30), HTML);
});
