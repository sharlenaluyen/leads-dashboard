import fs from "fs";

// Identifies the version of a file on disk: it changes whenever the file is
// rewritten, in place (size, mtime) or by write-then-rename (inode). null
// when the file doesn't exist.
export function fileSignature(file) {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Keeps what `load()` built from `file` until the file changes on disk, so
 * each get() costs one stat rather than a read and parse. Changes from
 * anywhere (this process, another one, a hand edit) are picked up on the
 * next get(). A load() that throws isn't cached.
 *
 * set(value) records what this process just wrote, so the next get() doesn't
 * read it straight back.
 */
export function cachedByFile(file, load) {
  let state = null; // { sig, value }
  return {
    get() {
      // Signature first: if the file changes during load(), the next get()
      // sees a newer signature and loads again.
      const sig = fileSignature(file);
      if (!state || state.sig !== sig) state = { sig, value: load() };
      return state.value;
    },
    set(value) {
      state = { sig: fileSignature(file), value };
    },
  };
}
