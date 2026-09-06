# oikist — Design Decisions

**Status:** M0-M8 complete, spike included. All six switch-bar items are built. The day 1
workday test ran on 2026-09-04: Wave was never opened, and VS Code's agent extensions won
the work instead. That result reversed two decisions and moved the fence — see sections
2, 3, 4 and 10. Current work is the section 10 roadmap, step 1.
**Recorded:** 2026-09-03 · **Amended:** 2026-09-05

This is the decision record for oikist, a Windows-only, agent-native development
environment. It exists so that neither future-me nor any agent working in this repo
has to re-derive choices that were already argued out. If you want to change
something here, change *this file* in the same commit.

---

## 0. What oikist is

A desktop app in which coding agents — Claude Code and Codex — are first-class
objects rather than processes that happen to live inside terminal panes. It answers
"which agent needs me, where, and what has it done" and lets work move between
providers without hand-rebuilding context.

It is **not** a terminal emulator. Measured split of a real working day: ~75% agent
panes, ~15% human shell, ~10% everything else. The terminal is a pane type, not the
substrate.

## 1. Greenfield, not a fork of Wave Terminal

**Decided:** build from scratch. A fork of `wavetermdev/waveterm` was created,
evaluated, and abandoned.

**Why.** Four findings, in order of weight:

1. **No remote use, ever — local Windows only.** Wave's Go backend (`pkg/remote`,
   `pkg/wsl`, `pkg/wslconn`, `pkg/genconn`, `pkg/wshrpc` and its Go-to-TS codegen)
   exists primarily to solve remote connections. That is the majority of ~86,000
   lines of Go, inherited and maintained for zero benefit.
2. **The terminal is not Wave's.** Wave renders with `@xterm/xterm` 6 +
   `@xterm/addon-webgl`, and edits with `monaco-editor`. Both are `npm install`.
   The perceived "smoothness" of Wave's terminal is a library, obtainable directly.
3. **The two headline features do not exist in Wave.** Provider routing and
   subagent visibility require identical new code in either world. A fork's only
   real advantage is day-one parity, and parity buys nothing where the product is.
4. **Wave is ~150k LOC** (~86k Go, ~64k TS/TSX). Writing novel features inside
   someone else's architecture, behind a codegen step, is strictly more expensive
   than writing them in an app you own.

**What this decision deleted:** upstream merge strategy, "delta budget" discipline,
isolated-subsystem structure, app/data-directory identity isolation from an existing
Wave install, and the Go + Task + Zig toolchain (none of which were installed).

**Kept:** the Wave source, at `C:\Users\SJ\ref\waveterm`, as reference. It is the
best available documentation on ConPTY handling on Windows, tiling layout
(~4,100 LOC), and block state modeling. Read it; do not build on it.

## 2. TypeScript, then a Rust host

**Superseded 2026-09-05.** The original decision — TypeScript throughout — stood on an
estimate that was checked and found wrong. See *The measurement that reopened this* at
the end of this section. The host process moves to Rust under Tauri; the renderer and
the pure domain layer stay TypeScript. **The order matters and is not negotiable: the
migration is the last step of the current roadmap, not the first.** Product work in
section 10 lands first, on the codebase that exists.

**What survives unchanged from the original reasoning**, and is the reason the renderer
is not part of this: the terminal is xterm.js in a browser engine, Tauri on Windows
renders in WebView2 which is Chromium, and so **the frontend is TypeScript regardless**.
Nothing about the language choice touches how the app looks or how fast it draws.

**What the port covers:** `pty`, `layout-store`, `launcher`, `discovery`, and file I/O.
**What it does not:** `layout.ts`, `agents.ts`, `handoff.ts`, `hooks.ts` and `files.ts`
are pure logic with no I/O. They stay TypeScript in the renderer, so the 442-line layout
suite and its siblings are never rewritten. `hook-server.ts` is deleted rather than
ported — see section 10.

**Cost accepted:** `node-pty` is replaced by a Rust ConPTY crate (`portable-pty`),
which retires hard rule 3 in `CLAUDE.md` as written. Agent development is slower in
async Rust than in TypeScript, and that was a real argument in the original decision;
it is accepted rather than refuted.

### The measurement that reopened this

Section 3 priced the entire Tauri saving at *"~140MB disk, ~200MB baseline RAM"* and
called it meaningless. That number was an estimate and was never checked. Measured on
2026-09-05:

```
dist/win-unpacked          371M
  └ electron runtime       345M
your application code      1.2M
```

The real disk figure is **~345MB — 2.5x the recorded estimate** — and the application
is **0.3% of what ships**. A Tauri build is roughly 10-20MB, WebView2 already being
present on Windows 11: a ~96% cut. That is not the difference the record argued against.

This is the escape hatch below working as designed. It asked for a measurement rather
than an opinion, and a measurement is what moved it. It is worth being precise about
what the measurement does and does not prove: it establishes the saving is far larger
than recorded, **not** that 371MB was costing anything. Nothing in the workday log
complained of size. This is a want, honestly arrived at, not a need.

**Escape hatch (unchanged, and still the standard for reversing this):** if measurement
ever shows a hot path — pty streaming, project indexing, NPU inference — write *that
piece* natively. Surgically, after measuring. Not on a hunch.

---

**The original decision, retained for the record:**

**Decided:** TypeScript throughout.

**Why.** Rust is common in this space because Zed wrote its own GPU GUI framework
and Alacritty/Ghostty are glyph rasterizers. Neither describes oikist: the terminal
is xterm.js in a browser engine, so **the frontend is TypeScript regardless**, and
the language choice only ever governs the host process. Against that:

- ~9,000 lines of working TypeScript already exist in `wave-devtools` and *are* the
  domain layer. Rust means rewriting the hardest, most provider-specific code for
  no new capability.
- Development is agent-driven under real rate limits. Agents are markedly more
  productive in TypeScript than in async Rust with IPC and a GUI layer. This is a
  throughput decision.

**Escape hatch:** if measurement ever shows a hot path — pty streaming, project
indexing, NPU inference — write *that piece* as a Rust sidecar or native module.
Surgically, after measuring. Not as a foundation.

## 3. Electron — spike run, then reversed on footprint

**Amended 2026-09-05.** Electron is replaced by Tauri as the last step of the section 10
roadmap. **The performance half of this section was not overturned and still stands** —
it was right, and it is still the reason no one should expect the migration to make
anything faster.

**What stands.** ConPTY caps a pty at ~0.95 MB/s while Electron's IPC bridge carries
299 MB/s, so the bridge runs at ~0.3% of capacity and the bottleneck sits upstream of
both hosts. Tauri cannot be 25% better on a ceiling neither host owns, and the M0
decision rule below was met honestly. **The migration is expected to change throughput,
latency and appearance by nothing at all.** Anyone reading this later and hoping Rust
made the terminal faster: it did not, and it was never going to.

**What was overturned.** The sentence *"What Tauri saves (~140MB disk, ~200MB baseline
RAM) is meaningless on a 32GB machine"* rested on an unchecked estimate. Measured, the
disk saving is ~345MB of a 371MB install carrying 1.2MB of application code. Section 2
holds the numbers and the reasoning. **"Not to be revisited" was too strong a phrase for
a decision resting on a figure nobody had measured** — that is the lesson worth keeping
from this reversal, more than the outcome.

---

**The original decision, retained for the record:**

**Decided:** Electron. The M0 spike ran on 2026-09-03 and is recorded in
[`M0-SPIKE.md`](M0-SPIKE.md). ConPTY caps a pty at ~0.95 MB/s while Electron's IPC
bridge carries 299 MB/s, so the bridge runs at ~0.3% of capacity and the bottleneck sits
upstream of both hosts. Tauri cannot be 25% better on a ceiling neither host owns.
**Not to be revisited.**

**Why.** "Electron is slow" conflates the engine with the apps built on it.
Critically, **Tauri on Windows renders in WebView2, which is Chromium** — the
rendering profile is identical; you only stop bundling the runtime. What Tauri saves
(~140MB disk, ~200MB baseline RAM) is meaningless on a 32GB machine. What it costs
is a Rust host process — so the TS domain layer is rewritten, or exiled to a Node
sidecar, leaving two runtimes. Tauri's IPC bridge is also weakest at exactly the hot
path here: sustained high-volume pty streaming.

**The real performance lever is our own code**: pty write batching, React re-render
discipline, not blocking the main thread. Additionally, and unlike Wave or VS Code,
oikist should throttle background panes and only render the focused one at full
fidelity. That is worth more than the framework choice.

**M0 decision rule, fixed in advance:** build the same xterm + WebGL frontend on
both hosts. Pipe ~500k lines through each. If Tauri is not at least **25% better on
sustained throughput or input latency while streaming**, choose Electron and do not
revisit. Cold start and idle RAM are tiebreakers only.

## 4. Scope

- **Windows-only**, this machine (ThinkPad T14 Gen 6, Intel + NPU, 32GB). Stated in
  the README. Not an apology — most agent tooling is mac-first.
- **Out of v1:** SSH/remote, multi-platform, Monaco *editing*, command palette,
  project dashboards, NPU/local models, unsupervised agent-to-agent messaging,
  worktree comparison, plugin systems.
- **In v1:** a read-only file viewer.

**Fence amended 2026-09-05, after the day 1 workday test.** Three items moved; the
reasoning is in section 10.

- **Moved in — git.** Was never on the fence, in or out; it is now explicitly in, bounded:
  the diff of what an agent just changed, plus stage, commit, push, branch, log.
  **Rebase, merge-conflict resolution and blame stay out** and hand off to VS Code, for
  the same reason editing does.
- **Moved in — the native agent view.** Agent panes stop being terminals. Section 10.
- **Moved in — theming.** "Theming beyond one chosen look" is struck from the out-list,
  because the one chosen look was measured against real use and lost. This buys a
  revised look, not a theme system; a user-facing theme picker remains out.
- **Held out, deliberately — editing.** "Rarely but it still happens" is the frequency a
  hand-off serves better than an editor to maintain. The viewer stays read-only and
  gains an *open in VS Code* action. Monaco stays out, and would also re-add ~40MB
  immediately after section 2 justified a migration on footprint.

**Done was defined as:** all six switch-bar items below work, and oikist has been used
for one full workday without opening Wave.

**Done is now defined as:** all six switch-bar items work, and oikist has been used for
one full workday without reaching for **VS Code and its agent extensions**.

**Why the criterion changed.** Day 1 ran on 2026-09-04 and Wave was never opened — the
bar as written was met. It was the wrong bar. What got reached for instead was VS Code
with the Claude and Codex extensions, which means the criterion had named a competitor
that had already stopped being one. A test whose failure condition cannot occur is not a
test. The replacement names what actually wins the work today.

**Switch bar (the v1 spec, author's own words):**

1. Terminal fast enough for `npm run build` output
2. Connection between agents (Codex and Claude primarily)
3. Tabs come back after restart
4. Ability to see individual files
5. Terminal is still a terminal, but feels much smoother
6. Seeing subagents

If the bar is met and Wave still gets opened, believe the behavior, not the checklist.

## 5. Architecture

**Domain code runs in-process.** `wave-devtools`' `src/server/agents/*` and
`src/server/sessions/*` are pure logic; `app.ts`/`index.ts` are an HTTP shell. Drop
the shell, import the rest into Electron main. A daemon was rejected: its only real
advantage is tracking attention while oikist is closed, and Phase 3's Ruling 3
mandates no persistence (there is an fs-spy test asserting nothing is written), so a
daemon would preserve nothing. It buys a port, a token, and a second process.

**Layout: tabs + optional 2-up split, with a persistent agent rail as the spine.**
No tiling engine. The constraint nobody named in the original design chat is screen
real estate: a 14" 1920x1200 laptop has no room for six panes, and with 2-4 agents
you look at one at a time and glance at the rail for the rest. This also removes the
need for dockview or a custom ~4k-line tiler. Add tiling later, against a working
app, if it is ever actually missed.

**Working directory: per pane, inherited, and never changed under a running pane.**
A pane records where it started; anything opened from the tab bar — a tab, a split, an
agent, a file viewer, a handoff — inherits that directory from the focused pane. Two
consequences are deliberate. A pane's stored directory is *where it began*, not where the
shell is now: a prompt drifts with every `cd`, and tracking that needs shell integration
that does not exist here, so showing a live directory would mean showing one the prompt
disagrees with. And choosing a project opens a **new** tab rather than moving the current
one, because a running shell cannot be relocated. A stored directory that has since been
deleted falls back to home rather than failing to spawn — losing the convenience, never
the pane.

**Persistence: plain JSON, atomic writes.** Persisted: window/layout state, open
tabs, per-pane agent metadata (provider, sessionId, cwd, branch, last known state),
project list, rate-limit reset times. Volume is tens to hundreds of records. Session
*history* is not stored — `wave-devtools` already reads it from Claude's and Codex's
own files. `better-sqlite3` was rejected: it is a native module that fights every
Electron version bump, and `node-pty` is already one unavoidable native dependency.

**Restore: layout + session identity + last known state, with explicit
click-to-resume.** Never auto-resume. Auto-resume burns quota on launch, and an
agent silently continuing work nobody is watching is dangerous. A restored pane
reads e.g. "Claude / fallow / feat-onboarding / completed 8h ago" with one click to
resume.

**Deferred, worth revisiting after v1:** both providers hold sessions independently
of any UI (`claude --bg` background agents; `codex app-server daemon`). oikist could
become a *viewer* of durable sessions rather than their owner, so a crash stops
costing work.

## 6. Agent integration

**Hybrid launch, own-first.** Anything oikist launches is known with certainty;
anything it attaches to is known with confidence. Both states are visible in the UI.

**Owned agents** launch with:

- `--session-id <uuid>` — oikist generates the UUID. Session identity is *assigned*,
  not inferred.
- `--settings <file-or-json>` — hooks are injected per launch. **No mutation of
  `~/.claude/settings.json`.** oikist changes nothing about how Claude behaves
  outside oikist.

This is a significant finding: Phase 3's Task 4 (process-reuse guards, duplicate
sessionId handling, confidence scoring) exists to *recover* a fact that can simply be
assigned.

**Attached agents** are discovered via `claude agents --json`, which returns
`pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name` for every live session with no
TTY required. They get identity and coarse state, and are **visibly tagged
lower-confidence** — no hooks means no reliable "needs permission" signal. A global
hook install (Phase 3 Task 8, already built) remains available as an opt-in if the
gap becomes annoying in practice. It is not the default.

**Codex is integrated through `codex app-server`, not hooks.** Spiked 2026-09-03;
full findings in [`SPIKE-codex-app-server.md`](SPIKE-codex-app-server.md). It runs as
a stdio child process speaking line-delimited JSON-RPC, works on Windows, and
publishes `ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput"` as a typed
enum via `thread/status/changed` — the attention model Phase 3 derived by hand.
Approvals arrive as unanswered server-to-client *requests*, so no inference is
needed. `thread/list` supplies `cwd`, `gitInfo { sha, branch, originUrl }`, preview,
name and status per thread; `turn/diff/updated` supplies the live diff.
**Phase 3 Task 9, the Codex hook installer, is cut.**

**Codex is own-only on Windows.** `codex app-server daemon` lifecycle is Unix-only,
so there is no shared daemon to attach to and an app-server instance only sees
threads it loaded. oikist spawns and owns its own app-server process. Past Codex
sessions stay readable via `thread/list` and must be labeled as *history*, not live.
Revisit if the daemon becomes cross-platform.

**Generated bindings are checked into the repo** (`codex app-server generate-ts`),
pinned to a Codex version. The whole surface is marked experimental; a diff on the
generated directory after an upgrade is the breaking-change alarm.

**What actually shipped for Codex is narrower than this section describes**, and the
difference is recorded in [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md): a `+ CODEX` pane, a rail
row that is `launched` and permanently `STATE UNKNOWN`, and the rate-limit read. The
live-state half is blocked by the Unix-only daemon, not deferred by choice; the bindings
are simply not checked in yet. This paragraph stays as written because it is what was
decided — the gap belongs in the issues file, not hidden by editing the decision.

**Rate-limit awareness:** for **Codex**, read it exactly —
`account/rateLimits/read` and the `account/rateLimits/updated` push carry
`usedPercent`, `windowDurationMins` and `resetsAt` for both the 5-hour and 7-day
windows, plus plan type and credit balance. No parsing. For **Claude**, parse the
reset timestamp reactively out of error text, with a manual override present from
day one — that parse *will* break when wording changes.

**Handoff payload:** task prompt + working state (branch, worktree, files touched) +
**an agent-authored handoff note**, produced by asking the outgoing agent to write
"here's where I am, what I tried, what's left" before switching. Never raw
transcripts — enormous, mostly noise, and they blow the receiving agent's context on
turn one. A handoff that loses "what I already tried and why it failed" just makes
the second agent repeat the first agent's dead ends.

**Subagents:** start at a count/indicator so a pane reads as busy-with-three rather
than stuck; design toward a live tree. `claude --forward-subagent-text` is the lead
worth investigating. Apply the Phase 3 discipline throughout: show what can be
proven, tag what was inferred, and never let a wrong count make the whole panel
untrustworthy.

## 7. Process

**Testing split, written down so it does not erode:**

- **Domain layer — TDD.** The imported `wave-devtools` modules keep their tests and
  their failing-test-first discipline. This is where bugs are expensive and
  invisible.
- **UI layer — manual verification plus a handful of end-to-end smoke tests.**
  Attempting to TDD a React pane layout is how testing gets abandoned entirely.

**Agent context is layered.** A short root `CLAUDE.md` (with `AGENTS.md` pointing at
it) carries commands, the fence, and pointers. Everything else lives in `docs/` and
is read on demand. **Plans are capped at a few hundred lines.** The Phase 3 plan ran
to 4,689 lines and was re-read by agents every session; it contributed materially to
the quota exhaustion that prompted this redesign.

**Build tooling:** `electron-vite` — the same choice Wave made, with a working
configuration available in `ref/waveterm` to learn from. **pty layer:** `node-pty`,
accepting a native rebuild on every Electron version bump as a known recurring cost.

## 8. Predecessor: wave-devtools

`C:\Users\SJ\Downloads\wave-devtools` — ~9,000 lines of TypeScript, 105 commits.
Proved three features against real daily use: Ports, Sessions, Agent Attention.

It is the **prototype laboratory**, and its domain code migrates into oikist largely
verbatim. It is not deleted and not abandoned; it stays the daily attention tool
until oikist can replace it.

**Phase 3 finishes, then freezes.** Freeze means freeze — no Phase 4. The way this
project dies is building feature 12 of 40 forever and never switching off Wave.

## 9. Packaging: a real exe, because a daily driver has to be launchable

**Decided 2026-09-04, from use.** A tool launched with `npx electron .` from a terminal
only lives as long as that terminal. It cannot be pinned, and pinning `electron.exe`
instead opens Electron's own welcome window. `electron-builder` produces `oikist.exe`.

- **`dir`, not an installer.** The exe stays at `dist/win-unpacked/oikist.exe`, so it is
  pinned once and every later `npm run package` replaces the file the pin already points
  at. An installer would mean reinstalling to pick up a change, on a machine that
  rebuilds this app several times a day.
- **`asar: false`.** The hook relay is handed to Claude as a *path* and run by the real
  node binary, which cannot read inside an archive; node-pty's native binding has the
  same problem. Unpack rules and a path rewrite would solve both, but this app is
  installed on one machine, where an archive buys nothing worth a class of silent
  runtime failures.
- **`npmRebuild: false`.** The rebuild fails — winpty's gyp file shells out to a
  `GetCommitHash.bat` that is not on PATH — and has nothing to do: the binding from
  `npm install` is the one dev has been loading under this same Electron all along.
  Verified by opening a shell in the packaged app, not by reading.

`electron-builder` is a devDependency and a build tool, not a runtime dependency, so
rule 3 in `CLAUDE.md` — one native module — is untouched.

---

## 10. The agent pane stops being a terminal

**Decided 2026-09-05, from the day 1 workday test.** This is the largest decision in the
record after section 1, and it reverses an implementation choice rather than a stated
one — section 0 already said the terminal was not the substrate. The code made every
agent a terminal anyway.

### The finding

Day 1 ended with VS Code's agent extensions winning the work. Asked what they did
better, the answer was seven things: reopening an old session; occasionally viewing and
editing a file; git; **a caret instead of a block cursor**; **clicking into the middle of
typed text to fix it**; **markdown-style prompt input**; **previewing files attached to a
prompt.**

The last four are one item. They are not styling, and no font size or colour fixes any
of them. They are all consequences of a single fact: **the agent's prompt box is a
ConPTY grid.** A grid has no caret, no cursor position to click to, no rich text and no
attachment chips. xterm.js cannot provide them; neither can a different host language.
The competitor won because its extensions drive the agent programmatically and render
the conversation as real UI.

**Recorded plainly because it is the kind of thing that gets rationalised away later:
the seven complaints were read as a feature list for two hours before anyone noticed
they were one architectural defect.**

### The decision

Agent panes become native conversation views. Terminal panes remain, for shells, where a
terminal is the correct thing. `xterm.js` and the WebGL renderer stay — switch-bar item 1
is still a requirement and the shell pane still has to carry `npm run build` output.

**Transport: the real CLI binaries, spoken to over stream-json.** Not the API, not an
SDK re-implementation. `claude --print --input-format stream-json --output-format
stream-json`, with `--session-id` and `--resume`; `codex exec`, with its `resume` and
`fork` subcommands. The process model is unchanged from today — oikist still spawns the
same binary the user would have run, on the same subscription auth. Verified before
deciding: `codex exec -i/--image` gives attachment preview a real backend, and
`--disable-slash-commands` existing as a flag proves slash commands are **on** by
default in print mode, so `/model`, `/resume` and the rest survive the transport change.

### What this deletes

`--include-hook-events` puts hook lifecycle events directly into the stream-json output.
Agent state therefore arrives **inline, on the same pipe as the conversation**, and the
entire out-of-band path is removed: **`src/main/agents/hook-server.ts` (127 lines) and
`resources/hook-relay.mjs` are deleted, not ported.** With them go the ephemeral loopback
listener, the per-run bearer token, the per-launch `--settings` file, and the documented
trap that the relay must be run by a separately-resolved real `node` because
`process.execPath` is `electron.exe`.

This shrinks section 2's port list and removes a class of silent runtime failure. It is
the single best consequence of the decision and it was not the reason for making it.

### No raw-TUI escape hatch

**Rejected, with the reason recorded so it can be revisited on evidence.** A per-pane
flip to a live TUI was considered and cut: it is a *second transport*, not a display
option — it keeps `pty.ts` on the agent path permanently, gives one conversation two
representations, and puts pty back into the Rust port. It was worth paying for only if
stream-json could not reach something used daily, and the slash-command finding above
says it can. **If the next workday test finds a gap the TUI filled, add the flip then,
with that gap named.** Not upfront, on a guess.

### Attached sessions, and the two limitations that were called permanent

`KNOWN-ISSUES.md` recorded two blocks as other people's platforms: Codex live state
(`codex app-server daemon` is Unix-only, so an app-server cannot see a TUI in a pane),
and Claude activity (2.1.238 deleted `status`, `waitingFor` and `statusUpdatedAt`).

Both have a file-based route that neither block touches. Claude writes
`~/.claude/projects/<slug>/<sessionId>.jsonl`; Codex writes
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line is a `session_meta`
carrying `session_id`, `cwd`, `cli_version` and `source`. Both are appended as the
session runs — 181 and 373 files respectively on this machine when checked. **A file on
disk has no Unix-only problem.**

Two constraints on using them, both from existing rules. This is **inference**, so hard
rule 7 forces `confident`, never `certain`. And these files are full conversation
content, so oikist reads **mtime, size and message type only — never the text.**

Note what this is *for*: agents oikist launches report themselves over stream-json with
certainty. The JSONL route exists for **attached** sessions — ones started outside
oikist — and for the session history browser below. It is the fallback, not the path.

### Session history, git, and handoff

- **Session history browser.** Every past session on the machine, both providers,
  filterable by project, resumable. Built on the JSONL files above. No VS Code extension
  does this, because each one sees only its own provider.
- **Git, bounded.** The agent-diff — *what did this pane just change* — plus stage,
  commit, push, branch and log. The bound exists because the principle that hands
  editing to VS Code applies to rebase, merge conflicts and blame equally.
- **Handoff loses the clipboard.** With both sides of the conversation inside oikist,
  handoff pre-fills the target agent's composer and **leaves it unsent**. The human
  presses enter. This removes the paste without removing the human, and stays inside the
  fence's ban on unsupervised agent-to-agent messaging.

### Order

Each step ships on its own. **The migration is last**, and step 3 is a gate, not a
formality.

| | Step | Note |
|---|---|---|
| 1 | Look pass | Tracking, caps, rail width, dead space |
| 2 | Native agent view | The thesis. Everything below is decoration if this misses |
| 3 | **Workday test, against VS Code** | A gate. If the extensions still win, stop and re-plan |
| 4 | Session history browser | |
| 5 | Git, bounded | |
| 6 | Handoff, hook events, discovery cost, directory chip | Cleanup pass |
| 7 | Tauri migration | Section 2. Changes no behaviour by design |

---

## Ladder

| | Milestone | Notes |
|---|---|---|
| **M0** | ~~Two-arm spike~~ **done 2026-09-03** | Electron confirmed. See [`M0-SPIKE.md`](M0-SPIKE.md) |
| **M0.5** | ~~Spike `codex app-server`~~ **done 2026-09-03** | Task 9 cut. See [`SPIKE-codex-app-server.md`](SPIKE-codex-app-server.md) |
| **M1** | ~~Finish Phase 3; add clipboard handoff~~ **done 2026-09-03** | Tasks 10–13 + `npm run handoff`. Frozen. One open call: poll perf at saturation |
| **M2** | ~~Repo init~~ **done 2026-09-03** | electron-vite, React 19, sandboxed renderer over `app://` |
| **M3** | ~~Terminal, tabs, 2-up split, JSON layout~~ **done 2026-09-03** | Batched pty output; layout restored on launch |
| **M4** | ~~Agent rail, owned launch, hooks~~ **done 2026-09-03** | Launched agents report state; attached ones are labelled |
| **M5** | ~~Restore~~ **done 2026-09-03** | Agent panes restore dormant; explicit resume, never automatic |
| **M6** | ~~Read-only file viewer~~ **done 2026-09-03** | Bounded reads, binaries refused, no write channel exists |
| **M7** | ~~Routing + handoff~~ **done 2026-09-03** | Codex limits exact; Claude publishes none; handoff to clipboard |
| **M8** | ~~Subagent indicator~~ **done 2026-09-03** | Start/stop hooks fire and name the subagent |

Routing/handoff sits at M7 because it needs panes and a rail to live in — but the
**cheap half ships in M1**: a command that dumps prompt + branch + files touched +
handoff note to the clipboard. It works from a terminal with no UI, and it starts
paying back immediately on the work of building oikist itself. Dogfood the core idea
before the product exists.
