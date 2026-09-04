import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LISTED_FILES,
  composeHandoff,
  handoffProblem,
  parseGitStatus,
  type HandoffInput
} from "../src/shared/handoff.js";

const BASE: HandoffInput = {
  from: "claude",
  to: "codex",
  branch: "feat/agent-rail",
  worktree: "C:\\Users\\SJ\\oikist",
  task: "Finish the agent rail and its hooks.",
  note: "Discovery and the rail are done. The hook relay path was wrong; fixed. Launch still untested.",
  files: [{ status: "M", path: "src/main/index.ts" }],
  diffStat: " 1 file changed, 12 insertions(+), 2 deletions(-)"
};

test("the block carries the four things a receiving agent needs", () => {
  const text = composeHandoff(BASE);
  assert.match(text, /claude → codex/);
  assert.match(text, /feat\/agent-rail/);
  assert.match(text, /Finish the agent rail/);
  assert.match(text, /hook relay path was wrong/);
  assert.match(text, /M {2}src\/main\/index\.ts/);
});

test("a section with nothing to say is omitted rather than left empty", () => {
  const text = composeHandoff({ ...BASE, task: "", note: "", files: [], diffStat: "" });
  assert.equal(/## Task/.test(text), false);
  assert.equal(/## Where I got to/.test(text), false);
  assert.equal(/## Changed files/.test(text), false);
  assert.equal(/## Diff summary/.test(text), false);
  assert.match(text, /feat\/agent-rail/, "the branch is always worth stating");
});

test("a very long file list is capped so it cannot blow the receiver's context", () => {
  const files = Array.from({ length: MAX_LISTED_FILES + 25 }, (_, i) => ({ status: "M", path: `src/f${i}.ts` }));
  const text = composeHandoff({ ...BASE, files });
  const listed = text.split("\n").filter((line) => /^M {2}src\/f\d+\.ts$/.test(line));

  assert.equal(listed.length, MAX_LISTED_FILES);
  assert.match(text, /\+25 more/);
  assert.match(text, new RegExp(`Changed files \\(${MAX_LISTED_FILES + 25}\\)`));
});

test("the block is plain text and never embeds a transcript", () => {
  const text = composeHandoff({ ...BASE, note: "line one\nline two" });
  assert.equal(text.includes("\r"), false);
  // Nothing composed here comes from conversation history: the note is authored
  // deliberately and everything else is git state.
  assert.equal(/assistant:|"role"|\btool_use\b/i.test(text), false);
});

test("a missing note blocks the handoff, since that is the failure worth preventing", () => {
  assert.match(handoffProblem({ note: "" }) ?? "", /needs a note/);
  assert.match(handoffProblem({ note: "   \n " }) ?? "", /needs a note/);
  assert.equal(handoffProblem({ note: "tried X, it failed because Y" }), null);
});

test("git porcelain is parsed into status and path, including renames", () => {
  assert.deepEqual(
    parseGitStatus([" M src/main/index.ts", "A  tests/new.test.ts", "?? scratch.txt", "R  old.ts -> new.ts", ""].join("\n")),
    [
      { status: "M", path: "src/main/index.ts" },
      { status: "A", path: "tests/new.test.ts" },
      { status: "??", path: "scratch.txt" },
      { status: "R", path: "new.ts" }
    ]
  );
});

test("the leading space of an unstaged status is significant and preserved", () => {
  // Trimming both ends of porcelain output shifts every path one character left. This
  // shipped once in the predecessor and rendered tsconfig.json as sconfig.json.
  assert.deepEqual(parseGitStatus(" M tsconfig.json"), [{ status: "M", path: "tsconfig.json" }]);
});

test("parseGitStatus tolerates empty and whitespace-only output", () => {
  assert.deepEqual(parseGitStatus(""), []);
  assert.deepEqual(parseGitStatus("\n  \n"), []);
});
