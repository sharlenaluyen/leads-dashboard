// A problem with what was asked (bad input, a setting that's off, a row that
// moved): the server answers 400 with the message and doesn't log a stack.
// Anything else thrown is unexpected and gets a 500 and a logged stack trace
// (see wrap in app.js).
export class UserError extends Error {
  status = 400;
}

// Runs fn; if it throws, notes on the error what was being done ("Reading
// message 18c… (a Gmail draft)"), so the message shown can say which step
// failed. The innermost step wins. See explainGoogleError.
export async function during(step, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === "object" && !err.step) {
      try {
        err.step = step;
      } catch {
        // A frozen error keeps its own message.
      }
    }
    throw err;
  }
}
