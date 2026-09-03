# oikist — Design Decisions

**Status:** pre-M0. No implementation started.
**Recorded:** 2026-09-03

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

## 2. TypeScript, not Rust

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

## 3. Electron, pending a two-arm spike

**Decided:** Electron, subject to M0 below.

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
  worktree comparison, plugin systems, theming beyond one chosen look.
- **In v1:** a read-only file viewer.

**Done is defined as:** all six switch-bar items below work, and oikist has been used
for one full workday without opening Wave.

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

**Codex** exposes more than was assumed when Phase 3 was planned:
`codex app-server` (with `generate-ts` and `generate-json-schema` — an actual
protocol with TypeScript bindings), `codex agents`, `codex exec`, `codex apply`, and
`codex queue --thread <uuid> --message <text>`, which injects a message into a
running session. That last is the handoff primitive, already built upstream.
**Spike this before writing any Codex integration.**

**Rate-limit awareness:** parse the reset timestamp reactively out of provider error
text, with a manual override that is present from day one — the parse *will* break
when wording changes. Provider `/usage` output is a better signal where it can be
reached non-interactively; verify during the spike.

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

---

## Ladder

| | Milestone | Notes |
|---|---|---|
| **M0** | Two-arm spike: Electron vs Tauri | Decision rule in section 3, fixed in advance |
| **M0.5** | Spike `codex app-server` (~1h) | Decides whether Phase 3 Task 9 survives |
| **M1** | Finish Phase 3 in wave-devtools; add clipboard handoff command | Then freeze |
| **M2** | Repo init: electron-vite, layered docs, fence in README | |
| **M3** | Terminal: xterm + WebGL + node-pty, tabs, 2-up split, JSON layout | The real work |
| **M4** | Agent rail: domain modules in-process, own-first launch, attached discovery | |
| **M5** | Restore | |
| **M6** | Read-only file viewer | |
| **M7** | Routing + handoff, full | Cheap manual half ships in M1 |
| **M8** | Subagent indicator | |

Routing/handoff sits at M7 because it needs panes and a rail to live in — but the
**cheap half ships in M1**: a command that dumps prompt + branch + files touched +
handoff note to the clipboard. It works from a terminal with no UI, and it starts
paying back immediately on the work of building oikist itself. Dogfood the core idea
before the product exists.
