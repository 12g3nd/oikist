import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listDirectory, readTextFile } from "../src/main/files.js";
import { MAX_READ_BYTES } from "../src/shared/files.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oikist-files-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "readme.md"), "# hello\nsecond line\n", "utf8");
  await writeFile(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  await writeFile(join(dir, "src", "app.ts"), "export const x = 1;\n", "utf8");
  return dir;
}

test("a listing reports directories and file sizes, directories first", async (t) => {
  const dir = await fixture(t);
  const { entries } = await listDirectory(dir);

  assert.deepEqual(entries.map((entry) => entry.name), ["src", "binary.bin", "readme.md"]);
  assert.equal(entries[0]?.kind, "directory");
  assert.equal(entries[0]?.size, undefined, "a directory has no meaningful size here");
  assert.equal(entries[2]?.size, 20);
});

test("a text file reads back with its content", async (t) => {
  const dir = await fixture(t);
  const content = await readTextFile(join(dir, "readme.md"));

  assert.match(content.text, /# hello/);
  assert.equal(content.truncated, false);
  assert.equal(content.bytes, 20);
});

test("a binary file is refused rather than rendered as replacement characters", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(() => readTextFile(join(dir, "binary.bin")), /binary/);
});

test("a large file is truncated, and only the cap is read from disk", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "big.log");
  await writeFile(path, "x".repeat(MAX_READ_BYTES + 5_000), "utf8");

  const content = await readTextFile(path);
  assert.equal(content.truncated, true, "the reader says so rather than silently showing part");
  assert.equal(content.text.length, MAX_READ_BYTES, "no more than the cap is held in memory");
  assert.equal(content.bytes, MAX_READ_BYTES + 5_000, "the real size is still reported");
});

test("a relative path is refused, so nothing depends on the process working directory", async () => {
  await assert.rejects(() => readTextFile("readme.md"), /absolute/);
  await assert.rejects(() => listDirectory("src"), /absolute/);
  await assert.rejects(() => readTextFile(""), /absolute/);
});

test("a path containing a null byte is refused", async () => {
  await assert.rejects(() => readTextFile("C:\\temp\\file\0.txt"), /null byte/);
});

test("reading a directory says so instead of failing obscurely", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(() => readTextFile(join(dir, "src")), /directory/);
});

test("a missing path rejects rather than returning something empty", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(() => readTextFile(join(dir, "nope.txt")));
  await assert.rejects(() => listDirectory(join(dir, "nope")));
});
