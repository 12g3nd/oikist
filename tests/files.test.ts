import test from "node:test";
import assert from "node:assert/strict";

import { breadcrumbs, formatSize, isProbablyBinary, sortEntries, type FileEntry } from "../src/shared/files.js";

test("a NUL byte marks content binary, so it is never rendered as text", () => {
  assert.equal(isProbablyBinary(new TextEncoder().encode("plain text\nsecond line")), false);
  assert.equal(isProbablyBinary(new Uint8Array([0x48, 0x00, 0x49])), true);
});

test("a NUL past the sampled window is not looked for, matching git's heuristic", () => {
  const late = new Uint8Array(9000);
  late.fill(0x41);
  late[8500] = 0;
  assert.equal(isProbablyBinary(late), false, "only the first 8000 bytes decide");

  const early = new Uint8Array(9000);
  early.fill(0x41);
  early[7999] = 0;
  assert.equal(isProbablyBinary(early), true);
});

test("empty content is not binary", () => {
  assert.equal(isProbablyBinary(new Uint8Array()), false);
});

test("directories sort before files, then case-insensitively by name", () => {
  const entries: FileEntry[] = [
    { name: "readme.md", kind: "file" },
    { name: "Zebra", kind: "directory" },
    { name: "App.tsx", kind: "file" },
    { name: "assets", kind: "directory" }
  ];
  assert.deepEqual(
    sortEntries(entries).map((entry) => entry.name),
    ["assets", "Zebra", "App.tsx", "readme.md"]
  );
});

test("sorting does not mutate its input", () => {
  const entries: FileEntry[] = [{ name: "b", kind: "file" }, { name: "a", kind: "file" }];
  sortEntries(entries);
  assert.equal(entries[0]?.name, "b");
});

test("sizes read as sizes", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(999), "999 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatSize(-1), "");
  assert.equal(formatSize(Number.NaN), "");
});

test("breadcrumbs make every ancestor navigable, including the drive root", () => {
  assert.deepEqual(breadcrumbs("C:\\Users\\SJ\\oikist"), [
    { label: "C:", path: "C:\\" },
    { label: "Users", path: "C:\\Users" },
    { label: "SJ", path: "C:\\Users\\SJ" },
    { label: "oikist", path: "C:\\Users\\SJ\\oikist" }
  ]);
});

test("breadcrumbs tolerate trailing separators and forward slashes", () => {
  assert.deepEqual(breadcrumbs("C:/Users/SJ/"), breadcrumbs("C:\\Users\\SJ"));
  assert.deepEqual(breadcrumbs(""), []);
  assert.deepEqual(breadcrumbs("\\\\"), []);
});
