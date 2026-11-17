import fs from "fs";
import path from "path";
import { SERVER_PID_PATH } from "./config.js";
import { sheetLockIdle } from "./lock.js";
import { closeDb } from "./db.js";
import { app, startupSettings as settings } from "./app.js";

const server = app.listen(settings.port, "127.0.0.1", () => {
  // Lets npm run rebuild see that the server is running (see rebuild.js).
  fs.mkdirSync(path.dirname(SERVER_PID_PATH), { recursive: true });
  fs.writeFileSync(SERVER_PID_PATH, `${process.pid}\n`);
  console.log(`Leads dashboard: http://localhost:${settings.port}`);
});

// Only removes the file if it's still this process's (a newer server may
// have replaced it).
process.on("exit", () => {
  try {
    if (fs.readFileSync(SERVER_PID_PATH, "utf8").trim() === String(process.pid)) fs.rmSync(SERVER_PID_PATH);
  } catch {
    /* already gone */
  }
});
// Something async failed with nobody awaiting it. Log it and keep serving
// rather than crashing mid-write (Node's default).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

// On Ctrl-C, stop taking requests and let any spreadsheet write in progress
// (a sync, or an edit between logging the change and writing it) finish,
// then close SQLite cleanly. Gives up after SHUTDOWN_WAIT_MS; a second Ctrl-C
// exits at once.
const SHUTDOWN_WAIT_MS = 15_000;
let stopping = false;

function stop(signal) {
  if (stopping) {
    console.error(`${signal} again: exiting without waiting.`);
    process.exit(1);
  }
  stopping = true;
  console.log("Stopping: waiting for spreadsheet writes to finish (Ctrl-C again to exit now)…");
  server.close();
  const giveUp = setTimeout(() => {
    console.error(`A spreadsheet write was still running after ${SHUTDOWN_WAIT_MS / 1000} seconds; exiting anyway. Sync again after restarting to check the sheet.`);
    finish(1);
  }, SHUTDOWN_WAIT_MS);
  sheetLockIdle().then(() => {
    clearTimeout(giveUp);
    finish(0);
  });
}

function finish(code) {
  try {
    closeDb();
  } catch (err) {
    console.error("Closing the database failed:", err);
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
