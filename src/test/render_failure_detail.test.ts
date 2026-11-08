// Visibility N5 (G503): a failed overlay render reports the full HyperFrames error.
// The old code kept only the last 400 characters, cutting the meaningful head
// ("...der blocked by...") and hiding the actual runtime error in the middle.
import assert from "node:assert/strict";
import test from "node:test";
import { buildHyperFramesFailureError } from "../compositor/hf_overlay_tracking.js";
import { formatEnvelopeCompact } from "../mcp/mcp_format.js";

// Realistic renderer tail (pre-timeline ReferenceError): progress line, the failure
// line, the sub-timeline detail with the runtime error, and the closing line.
const RENDER_STDERR = [
  "[hyperframes] playerReadyTimeoutMs=45000 pollIntervalMs=250 maxConcurrentTimelines=4",
  "25% Failed: Render blocked by 1 correctness warning:",
  "- sub_timeline_script_failure: A composition script threw before its timeline registered (still unregistered: main) (runtime-error:ReferenceError: tanimsizFonksiyon is not defined [thrown at: hyperframes-composition://body:2:7]). Fix the error; a composition animated by…",
  "@hf-diagnostic {\"kind\":\"SUB_TIMELINE_SCRIPT_FAILURE\",\"subId\":\"sub\"}",
].join("\n");

test("G503: failure detail keeps head, middle, and tail", () => {
  const err = buildHyperFramesFailureError("compositions/kart", ["render"], {
    status: 1,
    stdout: "",
    stderr: RENDER_STDERR,
  });
  assert.equal(err.diagnostic.code, "CUTHOL-G503");
  const what = err.diagnostic.what;
  // Head: the failure line intact ("Failed: Render", never the cut "der blocked").
  assert.ok(/Failed: Render blocked by 1 correctness warning/.test(what), what);
  assert.ok(!/\.\.*der blocked by/.test(what), what);
  // Middle: the actual runtime error and its location.
  assert.ok(what.includes("sub_timeline_script_failure"), what);
  assert.ok(what.includes("ReferenceError: tanimsizFonksiyon is not defined"), what);
  assert.ok(what.includes("[thrown at: hyperframes-composition://body:2:7]"), what);
  // Tail: the closing diagnostic line.
  assert.ok(what.includes('@hf-diagnostic {"kind":"SUB_TIMELINE_SCRIPT_FAILURE"'), what);
});

test("G503: pathological logs lose only the tail", () => {
  const longLine = `Failed: ${"x".repeat(3000)}`;
  const err = buildHyperFramesFailureError("compositions/kart", ["render"], {
    status: 1,
    stdout: "",
    stderr: longLine,
  });
  assert.ok(err.diagnostic.what.startsWith("HyperFrames composition 'compositions/kart' failed to render; the render was stopped (no fallback image is substituted): Failed: xxx"));
  assert.ok(err.diagnostic.what.length < 2400);
});

test("compact: short errors print whole, long errors keep the head + pointer", () => {
  const short = formatEnvelopeCompact({
    envelope: {
      ok: false,
      diagnostic: { code: "CUTHOL-G503", what: "Render blocked by 1 warning.", suggestion: "Fix it." },
    },
  });
  assert.ok(short.isError);
  assert.ok(short.text.includes("Render blocked by 1 warning."), short.text);
  assert.ok(!short.text.includes("truncated"), short.text);
  const longWhat = `First failure line explains everything. ${"detail ".repeat(200)}`;
  const long = formatEnvelopeCompact({
    envelope: {
      ok: false,
      diagnostic: { code: "CUTHOL-G503", what: longWhat, suggestion: "Fix it." },
    },
  });
  assert.ok(long.text.includes("First failure line explains everything."), long.text);
  assert.ok(long.text.includes("full text in the JSON result"), long.text);
});
