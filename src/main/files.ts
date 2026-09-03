import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  MAX_ENTRIES,
  MAX_READ_BYTES,
  isProbablyBinary,
  sortEntries,
  type FileContent,
  type FileEntry
} from "../shared/files.js";

/**
 * Filesystem access for the read-only viewer.
 *
 * There is no root jail here, deliberately: this is a single-user development tool and
 * the whole point is to look at the files you are working on, which are scattered across
 * the disk. What is enforced instead is the shape of what comes back — absolute paths
 * only, bounded listings, bounded reads, and a refusal to render binaries as text.
 */

function requireAbsolute(path: string): void {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new Error("A file path must be absolute.");
  }
  if (path.includes("\0")) {
    // A NUL can truncate a path inside a native call, so it is refused rather than
    // normalised away.
    throw new Error("A file path may not contain a null byte.");
  }
}

export async function listDirectory(path: string): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  requireAbsolute(path);
  const dirents = await readdir(path, { withFileTypes: true });
  const capped = dirents.slice(0, MAX_ENTRIES);

  const entries = await Promise.all(
    capped.map(async (dirent): Promise<FileEntry | null> => {
      // Symlinks and junctions are reported by what they point at, since that is what
      // opening one would show.
      const kind = dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : null;
      if (kind === null && !dirent.isSymbolicLink()) {
        return null;
      }
      try {
        const info = await stat(join(path, dirent.name));
        return info.isDirectory()
          ? { name: dirent.name, kind: "directory" }
          : { name: dirent.name, kind: "file", size: info.size };
      } catch {
        // A broken link or a file that vanished between listing and stat. Skipped
        // rather than failing the whole listing.
        return null;
      }
    })
  );

  return {
    path,
    entries: sortEntries(entries.filter((entry): entry is FileEntry => entry !== null)),
    truncated: dirents.length > capped.length
  };
}

/**
 * Reads a file as text, up to a cap.
 *
 * Only the first `MAX_READ_BYTES` are read from disk — not read whole and then sliced —
 * so opening a huge log costs a bounded amount of memory rather than its full size.
 */
export async function readTextFile(path: string): Promise<FileContent> {
  requireAbsolute(path);
  const info = await stat(path);
  if (info.isDirectory()) {
    throw new Error("That path is a directory.");
  }

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);

    if (isProbablyBinary(sample)) {
      throw new Error("That file is binary, so there is nothing useful to show.");
    }

    return {
      path,
      text: sample.toString("utf8"),
      truncated: info.size > bytesRead,
      bytes: info.size
    };
  } finally {
    await handle.close();
  }
}
