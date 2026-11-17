import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedByFile, fileSignature } from "../src/fileCache.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-cache-"));

function counting(file) {
  let loads = 0;
  const cache = cachedByFile(file, () => {
    loads++;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  });
  return { cache, loads: () => loads };
}

test("a file is loaded once until it changes on disk", () => {
  const file = path.join(dir, "a.json");
  fs.writeFileSync(file, '{"n":1}');
  const { cache, loads } = counting(file);
  assert.deepEqual(cache.get(), { n: 1 });
  cache.get();
  cache.get();
  assert.equal(loads(), 1);

  fs.writeFileSync(file, '{"n":22}'); // in place, different size
  assert.deepEqual(cache.get(), { n: 22 });
  // Write-then-rename with the same size, as writeJsonAtomic and the
  // accounts store do: a new inode.
  fs.writeFileSync(`${file}.tmp`, '{"n":33}');
  fs.renameSync(`${file}.tmp`, file);
  assert.deepEqual(cache.get(), { n: 33 });
  assert.equal(loads(), 3);
});

test("a missing file is cached too, and its creation is noticed", () => {
  const file = path.join(dir, "later.json");
  const { cache, loads } = counting(file);
  assert.equal(cache.get(), null);
  assert.equal(cache.get(), null);
  assert.equal(loads(), 1);
  fs.writeFileSync(file, "[1]");
  assert.deepEqual(cache.get(), [1]);
  assert.equal(fileSignature(path.join(dir, "nope")), null);
});

test("set() records this process's own write without a reload", () => {
  const file = path.join(dir, "b.json");
  fs.writeFileSync(file, "[]");
  const { cache, loads } = counting(file);
  cache.get();
  fs.writeFileSync(file, "[1,2]");
  cache.set([1, 2]);
  assert.deepEqual(cache.get(), [1, 2]);
  assert.equal(loads(), 1);
});

test("a load that throws isn't cached", () => {
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{not json");
  const { cache, loads } = counting(file);
  assert.throws(() => cache.get());
  assert.throws(() => cache.get());
  assert.equal(loads(), 2);
});
