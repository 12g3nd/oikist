# oikist

A Windows-only, agent-native development environment. Coding agents (Claude Code and
Codex) are first-class objects, not processes that happen to live in terminal panes.

**Status:** M0-M8 complete. Day 1 workday test run 2026-09-04; it reversed two decisions
and moved the fence. Current work is the `docs/DECISIONS.md` section 10 roadmap, step 1.

## Read first

- `docs/DECISIONS.md` — every architectural decision with its reasoning. **Read this
  before proposing any change to architecture, dependencies, or scope.** If a
  decision changes, edit that file in the same commit.

## Commands

| | |
|---|---|
| `npm run dev` | electron-vite dev server |
| `npm run build` | build main, preload and renderer into `out/` |
| `npm run app` | run the built app (`electron .`) |
| `npm run package` | build `dist/win-unpacked/oikist.exe` — the pinned daily driver |
| `npm run verify` | typecheck then the full suite |
| `npm test` | the suite alone |
| `npm run bench <fixture>` | terminal throughput |

`npm run package` writes to a stable path on purpose: the taskbar pin points at that
file, so rebuilding replaces what the pin already resolves to. Reasoning in
`docs/DECISIONS.md` section 9.

## Hard rules

1. **Do not add anything on the v1 fence** (see below) without the fence being
   explicitly changed in `docs/DECISIONS.md` first.
2. **TypeScript now; a Rust host at step 7, and not before.** `docs/DECISIONS.md`
   section 2 was superseded on 2026-09-05 — the host process moves to Rust under
   Tauri, justified on a measured footprint (371MB shipped, 1.2MB of it ours). Until
   step 7 of the section 10 roadmap, **this repo is TypeScript and adding Rust is
   still wrong**: the product work comes first, on the code that exists. The renderer
   and the pure domain layer (`layout.ts`, `agents.ts`, `handoff.ts`, `hooks.ts`,
   `files.ts`) stay TypeScript permanently and are never ported.
3. **No new native modules.** `node-pty` is the one accepted native dependency, until
   step 7 replaces it with a Rust ConPTY crate. Adding any other (e.g.
   `better-sqlite3`) needs a decision-record entry.
4. **Never mutate the user's global agent config.** No writes to
   `~/.claude/settings.json` or `~/.codex/config.toml`. Owned agents get per-launch
   `--settings` and `--session-id`. oikist must change nothing about how Claude or
   Codex behave outside oikist.
5. **Persistence is plain JSON with atomic writes.** No database.
6. **Never auto-resume an agent.** Restore shows last known state; the human clicks
   to resume.
7. **Tag inferred data as inferred.** Launched agents are known with certainty;
   attached agents are known with confidence. The UI must show the difference.

## Testing split

- **Domain layer (`src/domain/**`) — TDD.** Failing test first. This is ported from
  `wave-devtools` and keeps its discipline.
- **UI layer — manual verification plus a few end-to-end smoke tests.** Do not
  attempt to TDD React pane layout.

Do not "improve" this split by extending TDD to the UI. It is a deliberate choice
recorded in `docs/DECISIONS.md` section 7.

## v1 fence

**Out:** SSH/remote, multi-platform, Monaco *editing*, command palette, project
dashboards, NPU/local models, unsupervised agent-to-agent messaging, worktree
comparison, plugin systems. Also out: rebase, merge-conflict resolution and blame —
git is bounded, see below.

**In:** a read-only file viewer with an *open in VS Code* action; the native agent
view; git bounded to the agent-diff plus stage, commit, push, branch, log; a revised
look (one look, still no theme picker).

**Done:** all six switch-bar items in `docs/DECISIONS.md` section 4 work, and oikist
has been used for one full workday **without reaching for VS Code and its agent
extensions**. The old criterion said "without opening Wave"; day 1 met it while
losing to VS Code, so the criterion named a competitor that had stopped being one.

**Current work:** the section 10 roadmap. Step 1, the look pass. Do not start step 7
(Tauri) early — the order is the decision, not just the destination.

## Writing plans

Plans go in `docs/PHASE-N-<name>.md` and are **capped at a few hundred lines**. The
predecessor project's 4,689-line plan was re-read by agents every session and
materially contributed to quota exhaustion. Short plans, read on demand.

## Reference material

- `C:\Users\SJ\ref\waveterm` — Wave Terminal source. **Reference only, never a
  dependency.** Useful for: ConPTY handling on Windows, tiling layout, block state
  modeling, and a working `electron-vite` configuration.
- `C:\Users\SJ\Downloads\wave-devtools` — the predecessor. Its `src/server/agents/*`
  and `src/server/sessions/*` are the domain layer that migrates into this repo.

## Verifying the UI

The renderer is verified by looking at it. `OIKIST_CAPTURE=<path> npx electron .` opens
the window, photographs the app's own contents, writes a PNG and exits. Use that rather
than a desktop screenshot — a desktop capture also photographs whatever else is on
screen, which is both a privacy problem and an unreliable way to see the app.

Renderer console messages, load failures and preload errors are forwarded to the main
process's stdout, so a renderer that fails to boot reports why instead of presenting as
a blank window.

## Two constraints that will bite again

- **The preload must build as CommonJS** (`format: "cjs"`, `index.cjs`). It runs
  sandboxed, so `import` throws "Cannot use import statement outside a module", the
  bridge never installs, and the window goes blank.
- **The renderer is served over `app://`, never `file://`.** A `file://` page has an
  opaque origin, so `script-src 'self'` in its CSP matches nothing and every module
  script is silently blocked.

## Measuring whether the app exited

Do not judge this by a wrapper's exit code, `Process.WaitForExit`, or a PID lookup. All
three gave false answers during the M3 investigation: PowerShell's `Start-Process`
object reported `HasExited: True` while child processes survived, and Windows reuses
PIDs fast enough that an id-based check finds an unrelated process. Poll by process
**name** (`Get-Process electron`) against a baseline taken before launch.

`OIKIST_CLOSE_TEST=<ms> npx electron .` closes the window on the normal user path, so a
headless run can assert the app actually exits. `docs/KNOWN-ISSUES.md` records why this
guard exists and how the original defect was found.

## Layout and persistence

`src/shared/layout.ts` holds the tab/pane model as pure reducers — no React, no
Electron, no filesystem — so it is fully unit tested. `parseLayout` treats stored state
as untrusted: it repairs dangling ids, drops duplicates, caps tab counts, and never
throws. A corrupt file must cost the tab arrangement, never the ability to open the app.

State is written **when it changes**, never in a quit handler, debounced and atomically
(temp file + rename) in `src/main/layout-store.ts`.

Two traps already hit here, both worth remembering:

- **Strip a leading BOM before `JSON.parse`.** Editors and PowerShell's `-Encoding utf8`
  write one, and it makes the parse throw — which silently resets the layout.
- **`[hidden]` needs `display: none !important`.** The attribute works through a UA rule
  that any explicit `display` in our stylesheet outranks, so a hidden tab kept rendering
  its terminal below the visible one.
- **A pane's `cwd` is where it started, not where the shell is now.** It is inherited by
  anything opened from the tab bar and read once, when the pty is created. Do not try to
  keep it in step with the prompt: that needs shell integration this project does not
  have, and a directory label that disagrees with the prompt is worse than none.

## Windows paths through the agent's own shell

Writing a backslash into a file through the Bash tool loses one level of escaping, quoted
heredocs included. `"C:\\Users\\SJ"` in a heredoc lands as `C:\Users\SJ` in the source,
which JavaScript then reads as `C:UsersSJ`, and `/[/\\]+/` lands as an unterminated
regex. It cost two cycles on the working-directory work. Write path literals and
backslash-bearing regexes with the Edit tool, or build them with `String.fromCharCode(92)`.

## How agent state reaches the app

Two paths, and the difference is visible in the UI:

- **Launched** (`certain`) — oikist spawned the agent with `--session-id` (assigned, not
  recovered) and `--settings` pointing at a per-launch hooks file. Its hooks run
  `resources/hook-relay.mjs`, which POSTs `{sessionId, kind}` to an ephemeral loopback
  listener bound on `127.0.0.1:0` with a per-run bearer token. Nothing is ever written
  to `~/.claude/settings.json`.
- **Attached** (`confident`) — found by polling `claude agents --json` every 5s. Identity
  only. Claude 2.1.238 no longer publishes activity anywhere readable, so these rows say
  `STATE UNKNOWN` rather than guessing.

Never flatten those two into one label. A status panel that shows a guess as a fact
stops being believed the first time it is wrong.

### Traps hit building this

- **node-pty does not search PATH.** A bare `claude` fails with `File not found:`.
  Resolve to an absolute `.exe` first; a `.cmd` shim will not work either.
- **The hook relay must run under real Node, not Electron.** `process.execPath` is
  `electron.exe`, which behaves as Node only with an env var a hook definition cannot
  set, so the launcher resolves `node` from PATH.
- **Never put a caller-supplied value in an effect's dependency array** if it can round
  trip through the parent. This has now bitten three times. `onExit` on the terminal recreated the pty on every parent render,
  spawning duplicate shells and duplicate rail rows; `onPathChange` on the file viewer
  re-ran its effect and cleared the file being read, so opening a file looked like
  nothing happening; and `resumeSessionId` — which the pane itself reports upward — came
  back down and relaunched the agent with `--resume` for a session that did not exist
  yet. Hold it in a ref and keep it out of the deps.
- **A no-op state change must return the identical object.** A reducer that rebuilds
  the layout for an unchanged value makes a component that reports state upward loop
  forever: report, re-render, report again.
- **`--test-force-exit` is not free on Windows.** It kills the process while handles are
  still closing and trips a libuv assertion. `tests/pty.test.ts` needs it (node-pty
  never releases the loop); anything using `fetch` will crash under it, so those tests
  use `node:http` with `agent: false`.

## Restore never starts an agent

`parseLayout` marks **every** restored agent pane `dormant`, unconditionally — the flag
is imposed, not read back from the file, so nothing a stored layout contains can cause a
launch on startup. A dormant pane renders a card saying what it was, with the session id
it can resume, and starts only when clicked.

This is a hard rule, not a preference. Launching on restore spends quota the moment the
app opens, and an agent resuming work nobody is watching is worse than one that waits.
Verified by measurement rather than by reading: restoring an agent pane leaves the
`claude` process count unchanged.

A shell pane is never dormant — a shell costs nothing to start.

## Enumerating Claude's hook surface for free

`claude doctor` reads settings from the current directory without a trust prompt, and
prints the complete list of valid hook events when it meets an unknown one. Drop a
settings file with a bogus event into a scratch directory and run it there — no tokens
spent. Unknown events are ignored rather than fatal, so registering one a future version
drops degrades quietly.

Subagent tracking uses `SubagentStart`/`SubagentStop`, verified live: both fire, and the
payload's `subagent_type` names the subagent. That label is the only payload field the
relay forwards — everything else in a hook payload is prompt or tool text.

## Comparing two measurements

Numbers from two different harnesses are not a comparison. The M0 spike first reported
that pty batching cost 45% throughput; it did not. Raw node-pty had been measured in a
plain `.mjs` process and `PtyManager` under `tsx`, with different idle detection, so the
harness difference was the entire result. Rerun as one process with one harness, varying
only the consumer, batching turned out to be *faster*.

When a benchmark runs variants in sequence, **run it in both orders**. The OS file cache
warms across runs and produces a convincing monotonic trend that means nothing.
`BENCH_REVERSE=1` does this for `tests/batching.bench.mts`.

Counter-intuitive but measured: a pty consumer that does *more* work per read is faster,
because node-pty and ConPTY coalesce into larger reads when the consumer is not draining
instantly. At ~425,000 reads the per-read overhead dominates the bytes.
