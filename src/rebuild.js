// npm run rebuild: throw away the SQLite cache and rebuild it from the
// spreadsheets and Gmail. Sources and settings (config/) are kept.
//
// Refuses while the dashboard server is running: the server keeps the old
// database file open, so it would carry on with the deleted copy, and both
// would sync and write to the sheets at once. With the server running, use
// Settings → Hard reset instead, which does the same thing inside it.
import fs from "fs";
import { SERVER_PID_PATH, loadSettings } from "./config.js";
import { runReset } from "./sync.js";

// The pid a running server recorded, if that process is still alive.
function serverPid() {
  let pid;
  try {
    pid = Number(fs.readFileSync(SERVER_PID_PATH, "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err.code === "EPERM" ? pid : null;
  }
}

// A server started before it recorded its pid still answers on its port.
async function portAnswers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

const { port } = loadSettings();
const pid = serverPid();
if (pid || (await portAnswers(port))) {
  console.error(
    `The dashboard server is running (${pid ? `pid ${pid}` : `something answers on port ${port}`}). ` +
      "Use Settings → Hard reset in the dashboard, or stop npm start / npm run dev and run npm run rebuild again." +
      (pid ? `\nIf no server is running, delete ${SERVER_PID_PATH} and try again.` : "")
  );
  process.exit(1);
}
fs.rmSync(SERVER_PID_PATH, { force: true });

const result = await runReset();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
