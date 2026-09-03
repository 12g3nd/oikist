# oikist

A Windows-only, agent-native development environment. Coding agents (Claude Code and
Codex) are first-class objects, not processes that happen to live in terminal panes.

**Status:** pre-M0. No implementation yet. Commands below appear as they are built.

## Read first

- `docs/DECISIONS.md` — every architectural decision with its reasoning. **Read this
  before proposing any change to architecture, dependencies, or scope.** If a
  decision changes, edit that file in the same commit.

## Commands

_None yet — this repo is pre-M0. Fill this in at M2._

## Hard rules

1. **Do not add anything on the v1 fence** (see below) without the fence being
   explicitly changed in `docs/DECISIONS.md` first.
2. **TypeScript only.** No Go, no Rust, no new language runtimes. The escape hatch
   for a measured hot path is documented in `docs/DECISIONS.md` section 2 — it
   requires a measurement, not an opinion.
3. **No new native modules.** `node-pty` is the one accepted native dependency.
   Adding a second (e.g. `better-sqlite3`) needs a decision-record entry.
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
comparison, plugin systems, theming beyond one chosen look.

**In:** a read-only file viewer.

**Done:** all six switch-bar items in `docs/DECISIONS.md` section 4 work, and oikist
has been used for one full workday without opening Wave.

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
