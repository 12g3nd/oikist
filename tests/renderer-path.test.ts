import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveRendererPath } from "../src/shared/renderer-path.js";

const ROOT = join("C:", "app", "out", "renderer");

test("the root path serves the entry document", () => {
  assert.equal(resolveRendererPath(ROOT, "/"), join(ROOT, "index.html"));
  assert.equal(resolveRendererPath(ROOT, ""), join(ROOT, "index.html"));
});

test("assets inside the renderer directory resolve", () => {
  assert.equal(resolveRendererPath(ROOT, "/assets/index-abc.js"), join(ROOT, "assets", "index-abc.js"));
  assert.equal(resolveRendererPath(ROOT, "/index.html"), join(ROOT, "index.html"));
});

test("traversal out of the renderer directory is refused", () => {
  for (const attempt of [
    "/../main/index.js",
    "/assets/../../main/index.js",
    "/../../../../Windows/System32/drivers/etc/hosts",
    "/%2e%2e/main/index.js",
    "/assets/%2e%2e%2f%2e%2e%2fmain/index.js"
  ]) {
    assert.equal(resolveRendererPath(ROOT, attempt), null, attempt);
  }
});

test("a NUL byte is refused rather than normalised away", () => {
  assert.equal(resolveRendererPath(ROOT, "/index.html\0.png"), null);
  assert.equal(resolveRendererPath(ROOT, "/%00"), null);
});

test("a malformed percent-escape is refused rather than guessed at", () => {
  assert.equal(resolveRendererPath(ROOT, "/%"), null);
  assert.equal(resolveRendererPath(ROOT, "/%zz"), null);
});

test("a path that merely starts with the root name does not escape by prefix", () => {
  // "renderer-evil" shares a prefix with "renderer" but is a different directory; the
  // relative-path check must not be fooled by string prefixes.
  assert.equal(resolveRendererPath(ROOT, "/../renderer-evil/index.html"), null);
});
