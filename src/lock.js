// Everything that writes to a spreadsheet (sync, dashboard edits, undo, added
// rows, saved drafts) runs through this one queue, one at a time. Writes go
// by row number after a read, so two writers overlapping could each act on
// a stale read: a dashboard edit made mid-sync could be overwritten by the
// sync's write, or two added rows could land on the same row.
//
// Not reentrant: code holding the lock must not call another locked
// function (call its unlocked version instead).
//
// A holder gets at most LOCK_LIMIT_MS. Google calls have their own timeout
// (see google.js), so this only trips if something hangs anyway; the caller
// gets an error and the queue moves on instead of every later write waiting
// until a restart. The stuck work isn't cancelled (JavaScript can't), so if
// it ever wakes up it may still write.
export const LOCK_LIMIT_MS = 10 * 60 * 1000;

let tail = Promise.resolve();

export function withSheetLock(fn, { limitMs = LOCK_LIMIT_MS } = {}) {
  const run = tail.then(() => withTimeLimit(fn, limitMs));
  tail = run.catch(() => {});
  return run;
}

function withTimeLimit(fn, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`A spreadsheet write took longer than ${Math.round(ms / 1000)} seconds and was abandoned. Sync again to check the sheet.`);
      console.error(err);
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(fn), limit]).finally(() => clearTimeout(timer));
}

// Resolves once nothing holds or is waiting for the lock, including work
// queued while waiting. Used on shutdown (see server.js).
export async function sheetLockIdle() {
  let seen;
  do {
    seen = tail;
    await seen;
  } while (seen !== tail);
}
