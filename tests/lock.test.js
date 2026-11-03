import { test } from "node:test";
import assert from "node:assert/strict";
import { withSheetLock } from "../src/lock.js";

test("sheet writers run one at a time, in order, even after one fails", async () => {
  const log = [];
  const step = (name, ms, fail) =>
    withSheetLock(async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name} end`);
      if (fail) throw new Error(name);
    });
  const a = step("a", 20, true);
  const b = step("b", 5);
  await assert.rejects(a, /a/);
  await b;
  assert.deepEqual(log, ["a start", "a end", "b start", "b end"]);
});
