// A problem with what was asked (bad input, a setting that's off, a row that
// moved): the server answers 400 with the message and doesn't log a stack.
// Anything else thrown is unexpected and gets a 500 and a logged stack trace
// (see wrap in server.js).
export class UserError extends Error {
  status = 400;
}
