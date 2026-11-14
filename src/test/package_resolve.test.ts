/**
 * Package-resolve test: the shared Node-resolver helper finds HyperFrames and
 * GSAP from the normal clone layout (fallback path), and the compositor
 * wrappers agree with it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveBundledGsapMinJs, resolveHyperFramesCliMjs } from "../core/package_resolve.js";
import { findLocalGsapMinJs, findLocalHyperFramesCliMjs } from "../compositor/hf_common.js";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";

test("resolver finds the HyperFrames CLI and agrees with hf_common", () => {
  const resolved = resolveHyperFramesCliMjs();
  assert.ok(resolved, "expected resolveHyperFramesCliMjs() to find the CLI");
  assert.ok(fs.existsSync(resolved as string), `CLI path does not exist: ${resolved}`);
  assert.equal(findLocalHyperFramesCliMjs(), resolved);
});

test("resolver finds gsap and agrees with both wrappers", () => {
  const resolved = resolveBundledGsapMinJs();
  assert.ok(resolved, "expected resolveBundledGsapMinJs() to find gsap.min.js");
  assert.ok(fs.existsSync(resolved as string), `gsap path does not exist: ${resolved}`);
  assert.equal(findLocalGsapMinJs(), resolved);
  assert.equal(findBundledGsapMinJs(), resolved);
});
