import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LayoutStore } from "../src/main/layout-store.js";

async function temporaryDirectory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oikist-layout-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a missing file loads as empty rather than failing", async (t) => {
  const dir = await temporaryDirectory(t);
  const store = LayoutStore.in(dir);
  assert.deepEqual(await store.load(), {});
});

test("state is written and read back", async (t) => {
  const dir = await temporaryDirectory(t);
  const store = LayoutStore.in(dir);
  await store.load();
  store.setLayout({ version: 1, tabs: [], activeTabId: null });
  store.setWindow({ width: 1000, height: 700, maximized: false });
  await store.flush();

  const reloaded = await LayoutStore.in(dir).load();
  assert.deepEqual(reloaded.window, { width: 1000, height: 700, maximized: false });
  assert.deepEqual(reloaded.layout, { version: 1, tabs: [], activeTabId: null });
});

test("a corrupt file loads as empty instead of throwing", async (t) => {
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "layout.json"), "{ this is not json", "utf8");
  assert.deepEqual(await LayoutStore.in(dir).load(), {});
});

test("a JSON array is rejected: the file must hold an object", async (t) => {
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "layout.json"), "[1,2,3]", "utf8");
  assert.deepEqual(await LayoutStore.in(dir).load(), {});
});

test("rapid changes collapse into one file, leaving no temp files behind", async (t) => {
  const dir = await temporaryDirectory(t);
  const store = LayoutStore.in(dir);
  await store.load();

  for (let i = 0; i < 50; i += 1) {
    store.setWindow({ width: 800 + i, height: 600 });
  }
  await store.flush();

  const entries = await readdir(dir);
  assert.deepEqual(entries, ["layout.json"], `expected only the final file, saw ${entries.join(", ")}`);

  const parsed = JSON.parse(await readFile(join(dir, "layout.json"), "utf8"));
  assert.equal(parsed.window.width, 849, "the last value wins");
});

test("setting layout does not discard window bounds, and vice versa", async (t) => {
  const dir = await temporaryDirectory(t);
  const store = LayoutStore.in(dir);
  await store.load();
  store.setWindow({ width: 1234, height: 567 });
  store.setLayout({ version: 1, tabs: [], activeTabId: null });
  await store.flush();

  const reloaded = await LayoutStore.in(dir).load();
  assert.equal(reloaded.window?.width, 1234);
  assert.ok(reloaded.layout !== undefined);
});

test("a file written with a UTF-8 BOM still parses", async (t) => {
  // Editors and PowerShell's `-Encoding utf8` both produce one, and JSON.parse throws on
  // it — which would silently reset the layout to defaults.
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "layout.json"), "﻿" + JSON.stringify({ window: { width: 999, height: 500 } }), "utf8");

  const loaded = await LayoutStore.in(dir).load();
  assert.equal(loaded.window?.width, 999);
});
