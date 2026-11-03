// Everything that writes to a spreadsheet (sync, dashboard edits, undo, added
// rows, saved drafts) runs through this one queue, one at a time. Writes go
// by row number after a read, so two writers overlapping could each act on
// a stale read: a dashboard edit made mid-sync could be overwritten by the
// sync's write, or two added rows could land on the same row.
//
// Not reentrant: code holding the lock must not call another locked
// function (call its unlocked version instead).
let tail = Promise.resolve();

export function withSheetLock(fn) {
  const run = tail.then(fn);
  tail = run.catch(() => {});
  return run;
}
