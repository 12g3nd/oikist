/**
 * Reading files, and the rules for refusing to.
 *
 * The viewer is read-only by decision, not by omission: editing is on the v1 fence.
 * Everything here is pure so the guards can be tested without a filesystem.
 */

/**
 * The most text that is worth putting in front of a person at once.
 *
 * A larger file is shown truncated with a notice rather than refused: seeing the first
 * megabyte of a log is useful, and silently rendering a hundred megabytes into a DOM
 * node is not.
 */
export const MAX_READ_BYTES = 1024 * 1024;

/** Directory listings are capped for the same reason a poll is: a pathological case. */
export const MAX_ENTRIES = 2000;

export interface FileEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
}

export interface FileContent {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

/**
 * Git's heuristic: a NUL byte in the first 8000 bytes means binary.
 *
 * Rendering a binary as text produces a screenful of replacement characters that tells
 * the reader nothing and can lock up the renderer on a large file. Saying "this is
 * binary" is more useful than showing it badly.
 */
export function isProbablyBinary(sample: Uint8Array): boolean {
  const limit = Math.min(sample.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (sample[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Directories first, then files, each case-insensitively by name.
 *
 * Matches what every file browser does, because the alternative — raw filesystem
 * order — makes a listing impossible to scan.
 */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Sizes for a human, not for arithmetic. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Splits a path into its navigable ancestors, for a breadcrumb.
 *
 * Windows-shaped: a drive root is a real place you can be, and stays in the list.
 */
export function breadcrumbs(path: string): { readonly label: string; readonly path: string }[] {
  const normalized = path.replace(/\//g, "\\").replace(/\\+$/, "");
  if (normalized === "") {
    return [];
  }
  const parts = normalized.split("\\");
  const crumbs: { label: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const label = parts[i] ?? "";
    if (label === "") {
      continue;
    }
    const joined = parts.slice(0, i + 1).join("\\");
    // A bare drive letter needs its separator to be a usable path.
    crumbs.push({ label, path: i === 0 && label.endsWith(":") ? `${joined}\\` : joined });
  }
  return crumbs;
}
