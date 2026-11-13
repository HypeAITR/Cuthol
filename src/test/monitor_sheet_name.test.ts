import test from "node:test";
import assert from "node:assert/strict";
import { buildDefaultSheetPath } from "../monitor/preview.js";

test("two different time lists map to different default sheet files; same list maps to the same file", () => {
  const a = buildDefaultSheetPath("m", 2, 1, 13, [1000, 3000]);
  const b = buildDefaultSheetPath("m", 2, 1, 13, [2000, 4000]);
  assert.notEqual(a, b);
  const a2 = buildDefaultSheetPath("m", 2, 1, 13, [1000, 3000]);
  assert.equal(a2, a);
});
