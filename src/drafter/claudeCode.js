import { spawn } from "child_process";
import os from "os";

// After a timeout the process gets SIGTERM, then SIGKILL if it's still
// running this long after.
const KILL_GRACE_MS = 5000;
// Drafts for a full batch come to well under 1 MB; anything past this is
// runaway output and the process is stopped.
const MAX_STDOUT = 5 * 1024 * 1024;
// Only the start of stderr is shown in an error message.
const MAX_STDERR = 64 * 1024;

/**
 * Runs the locally installed Claude Code headless (`claude -p`), billed to
 * the user's Claude plan. Every tool is disabled and no MCP servers load, so
 * whatever is in the emails can only influence the text that comes back.
 */
export function complete({ system, prompt, model, timeoutMs }) {
  const args = [
    "-p",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--system-prompt",
    system,
  ];
  if (model) args.push("--model", model);

  return new Promise((resolve, reject) => {
    // Run outside the project so no CLAUDE.md or project settings load.
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killTimer;
    const stopChild = (err) => {
      reject(err);
      if (killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode !== "SIGKILL") child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      stopChild(new Error(`Claude Code took longer than ${Math.round(timeoutMs / 1000)} seconds; try fewer leads at once (draftBatchSize).`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (killTimer) return;
      stdout += d;
      if (stdout.length > MAX_STDOUT) {
        clearTimeout(timer);
        stopChild(new Error(`Claude Code returned more than ${MAX_STDOUT / 1024 / 1024} MB of output; stopped it.`));
      }
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STDERR) stderr += String(d).slice(0, MAX_STDERR - stderr.length);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new Error("The `claude` command wasn't found. Install Claude Code, or set CLAUDE_BIN.") : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new Error(`Claude Code failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`));
      }
      if (out.is_error) return reject(new Error(`Claude Code: ${out.result || out.subtype || "error"}`));
      resolve(out.result || "");
    });
    // If the process exits before reading the prompt, the write fails with
    // EPIPE; the close handler above reports it instead.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
