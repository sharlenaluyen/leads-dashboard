import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { complete } from "../src/drafter/claudeCode.js";

// A stand-in for the claude binary: a Node script run with the given body.
function fakeClaude(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

async function withBin(bin, fn) {
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
  }
}

test("returns the result from Claude Code's JSON output", async () => {
  const bin = fakeClaude(`process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ result: "hi" })));`);
  assert.equal(await withBin(bin, () => complete({ system: "s", prompt: "p", timeoutMs: 5000 })), "hi");
});

test("a process that ignores SIGTERM after a timeout is killed with SIGKILL", async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-pid-")), "pid");
  const bin = fakeClaude(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
  await withBin(bin, () => assert.rejects(complete({ system: "s", prompt: "p", timeoutMs: 2000 }), /took longer than/));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(), "still running right after SIGTERM");
  const until = Date.now() + 8000;
  while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(), "killed after the grace period");
});

test("runaway output stops the process instead of filling memory", async () => {
  const bin = fakeClaude(`const chunk = "x".repeat(1 << 16); const w = () => { while (process.stdout.write(chunk)); process.stdout.once("drain", w); }; w();`);
  await withBin(bin, () => assert.rejects(complete({ system: "s", prompt: "p", timeoutMs: 20000 }), /more than 5 MB/));
});
