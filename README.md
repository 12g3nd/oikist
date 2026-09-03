# oikist

An agent-native development environment for Windows.

Coding agents are first-class objects here, not processes that happen to live inside
terminal panes. oikist answers the question you actually have when three agents are
running: **which one needs me, where is it, and what has it done?** — and lets work
move between Claude Code and Codex without rebuilding context by hand.

**Status:** pre-M0. Design settled, nothing implemented. See
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Why this exists

Existing tools treat the agent as a feature in an IDE. On a normal working day here
the split is roughly **75% agent panes, 15% human shell, 10% everything else** — so
the agent is not a feature, it is the primary object, and the terminal is one pane
type among several.

Two problems fall out of that, and neither is solved anywhere today:

- **Attention.** With several agents running, knowing which one is blocked on you —
  and jumping straight to it — is the difference between parallel work and
  thrashing.
- **Routing and handoff.** Providers hit rate limits at different times. Moving a
  task from one to the other currently means reconstructing context by hand, which
  is slow enough that you usually just wait instead.

## Scope

**Windows only.** Built for one machine — a ThinkPad T14 Gen 6, 32GB. This is not an
apology or a temporary state; it is the scope. Most agent tooling is mac-first, so
being deliberately Windows-native is a feature.

### Not in v1

SSH/remote · multi-platform · Monaco *editing* · command palette · project
dashboards · NPU/local models · unsupervised agent-to-agent messaging · worktree
comparison · plugin systems · theming beyond one look.

This fence is load-bearing. The way a project like this dies is building feature 12
of 40 forever and never actually switching to it. Changing the fence means editing
[`docs/DECISIONS.md`](docs/DECISIONS.md) first.

### In v1

1. A terminal fast enough for `npm run build` output
2. Connection between agents — Claude and Codex
3. Tabs that come back after restart
4. The ability to see individual files
5. A terminal that is still a terminal, but feels much smoother
6. Seeing subagents

**Done** means all of the above work and oikist has been used for one full workday
without opening Wave Terminal.

## Relationship to Wave Terminal

oikist is **not** a fork of [Wave Terminal](https://github.com/wavetermdev/waveterm),
though it began as one. The fork was created, evaluated, and abandoned: Wave's
architecture is built substantially around remote connections, which this project
never uses, and its terminal and editor are `@xterm/xterm` and `monaco-editor` —
libraries anyone can use directly. That left inheriting ~150k lines to gain nothing
the product actually needed. The full reasoning is in
[`docs/DECISIONS.md`](docs/DECISIONS.md) section 1.

Wave remains excellent, and its source remains the best available reference on
ConPTY handling and tiling layout on Windows. It is read, not depended on.

The predecessor project, `wave-devtools`, was a plugin/daemon for Wave that proved
three features against real daily use — Ports, Sessions, and Agent Attention. Its
domain layer migrates into oikist.

## Stack

TypeScript · Electron · React · `@xterm/xterm` + WebGL · `node-pty` · `electron-vite`

Electron is pending a measured spike against Tauri; the decision rule is fixed in
advance in [`docs/DECISIONS.md`](docs/DECISIONS.md) section 3.

## License

TBD.
