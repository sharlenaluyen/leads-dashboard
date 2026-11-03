import { spawn } from "child_process";
import os from "os";

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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude Code took longer than ${Math.round(timeoutMs / 1000)} seconds; try fewer leads at once (draftBatchSize).`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new Error("The `claude` command wasn't found. Install Claude Code, or set CLAUDE_BIN.") : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new Error(`Claude Code failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`));
      }
      if (out.is_error) return reject(new Error(`Claude Code: ${out.result || out.subtype || "error"}`));
      resolve(out.result || "");
    });
    child.stdin.end(prompt);
  });
}
