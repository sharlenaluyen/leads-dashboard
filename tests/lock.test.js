import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetLockIdle, withSheetLock } from "../src/lock.js";

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

test("a holder that never finishes is abandoned after the limit and the queue moves on", async () => {
  const stuck = withSheetLock(() => new Promise(() => {}), { limitMs: 30 });
  const next = withSheetLock(async () => "next ran");
  await assert.rejects(stuck, /stopped waiting for it/);
  assert.equal(await next, "next ran");
});

test("sheetLockIdle waits for queued work, including work added while waiting", async () => {
  const log = [];
  withSheetLock(async () => {
    await new Promise((r) => setTimeout(r, 10));
    log.push("a");
    withSheetLock(async () => log.push("b"));
  });
  await sheetLockIdle();
  assert.deepEqual(log, ["a", "b"]);
});
