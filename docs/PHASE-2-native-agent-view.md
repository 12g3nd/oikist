# Phase 2 — the native agent view

Step 2 of the `DECISIONS.md` section 10 roadmap. **Read section 10 first**; it holds the
decision and the reasoning. This file holds only what is needed to build it.

The one-line version: agent panes stop being ConPTY grids and become native conversation
views driven over stream-json against the same CLI binaries.

---

## What was verified live, before planning

One `claude -p --output-format stream-json --include-hook-events --verbose --restricted`
run on 2026-09-05, five events. Everything below is observed, not assumed.

**`system` / `init`** — first event. Carries `session_id`, `cwd`, `model`,
`permissionMode`, `tools`, `agents`, `skills`, and **`slash_commands`** (count varies with
configuration: 50 under `--restricted`, 242 in a normal session).

**`assistant`** — `message` in Anthropic message shape, plus `parent_tool_use_id`,
`uuid`, `timestamp`.

**`rate_limit_event`** — carries `rate_limit_info`:

```json
{ "status": "allowed", "rateLimitType": "five_hour",
  "unifiedWindows": { "five_hour": { "utilization": 0.09, "resetsAt": 1788679800 },
                      "seven_day": { "utilization": 0.68, "resetsAt": 1788789600 } } }
```

**`system` / `post_turn_summary`** — `status_category` (observed: `review_ready`),
`status_detail` (observed: `"replied as requested"`), and **`needs_action`**.

**`result`** — `stop_reason`, `usage`, `total_cost_usd`, `num_turns`,
`permission_denials`, `subagent_stats`, `is_error`.

### Three recorded limitations that this stream retires

1. **"Claude publishes no live limits."** Recorded at M7 and in section 6; it is why the
   handoff view shows exact Codex numbers against nothing for Claude. `rate_limit_event`
   gives five-hour and seven-day utilisation with reset timestamps — the same shape as
   Codex's `account/rateLimits/read`. **The handoff view becomes symmetric.**
2. **Activity by inference.** `post_turn_summary` carries `status_category` and
   `needs_action` as first-class fields. "Which agent needs me" — the question section 0
   says this app exists to answer — is now *published by the CLI* rather than deduced
   from hook timing.
3. **The slash-command worry behind the raw-TUI escape hatch.** `init.slash_commands`
   enumerates them all. The composer can offer them natively. Section 10's rejection of
   the escape hatch now rests on an observation, not an inference from a flag name.

### What is NOT verified — do not plan as if it is

- ~~`--include-hook-events` is unproven.~~ **Settled by task 1 — see below.**
- ~~`--input-format stream-json` multi-turn was not exercised.~~ **Settled by task 2.**
- **`codex exec --json` shape is unknown.** The flag exists ("Print events to stdout as
  JSONL"); nothing was spent confirming its events. Task 6. Note the section 6 hazard:
  the Codex weekly window has been exhausted before and silently shaped what got built.

---

## Task 1 result — hook events, settled

**Run 2026-09-05. The flag is required, and the relay can die.**

| condition | tool call | lifecycle hook events |
|---|---|---|
| `--include-hook-events` (n=2) | Bash, confirmed | `PreToolUse:Bash`, `PostToolUse:Bash`, `Stop`, `Stop` |
| no flag (n=2) | Bash, confirmed | **none** |

`SessionStart` events arrive either way; everything else needs the flag.

**Payload** — `system`/`hook_started` and `system`/`hook_response`:

```json
{ "type": "system", "subtype": "hook_started", "hook_id": "6c01c1fb-...",
  "hook_name": "PreToolUse:Bash", "hook_event": "PreToolUse",
  "uuid": "...", "session_id": "..." }
```

Note what is *absent*: no prompt text, no tool input, no tool output. The stream already
enforces what `hook-relay.mjs` had to be careful to do by hand — forward the label, never
the content.

### Two things this changes

**A settings file is still needed, but the relay is not.** Hook events report *configured
hooks running*; with no hook configured for an event, nothing fires. So a per-launch
`--settings` file stays (hard rule 4 — never the global one). Its commands become
**no-ops** (`cmd /c exit 0`): the event reaches oikist by being on the stream, not by the
command doing anything. `hook-server.ts`, `hook-relay.mjs`, the loopback listener, the
bearer token and the real-`node` resolution all die.

**Consider skipping hooks entirely.** `assistant` messages already carry `tool_use`
blocks, and `post_turn_summary` carries `needs_action`. Between them, "what is this agent
doing" may need no hooks at all — which would drop the settings file too. **Unverified:
whether `SubagentStart`/`SubagentStop` (the M8 feature) have a non-hook equivalent.**
**Answered by task 3 for activity (hooks unnecessary); still open for subagents.**

### The confound, recorded because it nearly produced a wrong answer

The first design — flag/no-flag/control, one run each — gave line counts of 22/29/22 and
looked decisive. It was not. Two faults:

1. **The user's global config has 5 `SessionStart` hooks.** Every arm inherited them, so
   the baseline was never zero and `--settings` merges with global rather than replacing
   it. **oikist will receive the user's own hooks' events on the stream and must ignore
   them by `hook_name`.**
2. **The model did not call a tool in two of the three arms.** The 7-line difference was
   entirely explained by *whether Bash ran*, not by the flag. Only forcing the tool call
   and re-running made the arms comparable.

This is the M3 lesson repeating: validate the measurement before believing what it says.
A prompt that lets the model choose whether to use a tool is not a controlled arm.

---

## Task 2 result — one long-lived process, and a reducer trap

**Run twice, 2026-09-05, identical both times.** Two turns over a single stdin pipe with
`--input-format stream-json` and an assigned `--session-id`:

| | |
|---|---|
| turns completed | 2 |
| process alive between turns | **true** (`exitCode === null`) |
| unique session ids | **1** — the one requested |
| context retained | turn 1 planted "47", turn 2 answered `47` |
| exit | 0, after stdin closed |

**So `AgentSession` owns a long-lived child process.** Tasks 3 and 5 keep the shape the
plan assumed; the one-process-per-turn `--resume` fallback is not needed.

### Observed sequence

```
hook_started x5, hook_response x5          <- SessionStart hooks, ONCE, at process start
init, assistant, rate_limit_event, post_turn_summary, result   <- turn 1
init, assistant, rate_limit_event, post_turn_summary, result   <- turn 2
```

### The trap: `init` is per turn, not per session

Two `init` events, one process, one session id, context intact. **A reducer that treats
`init` as "new session, reset state" would wipe the conversation on every turn.** This is
the defect this experiment existed to prevent, and it would not have been obvious from
the flag documentation — `system/init` reads like a session-open event and is not one.

Turn boundaries are `result`. Session boundaries are the process. Do not conflate them.

Correspondingly: `SessionStart` hook events fire **once at process start**, not per turn,
so they cannot be used as a per-turn signal.

### Fixtures must be sanitised before entering this repo

The repo is public. A raw captured stream carries, in `init` alone: `cwd` including the
username, `messaging_socket_path` (a named pipe), `powershell_path`, and a full
enumeration of the machine's **242 slash commands, 190 skills, 14 plugins and 17
agents** — a complete inventory of the author's tooling. `rate_limit_event` carries real
utilisation figures, and `hook_name` values name the user's own global hooks.

**Task 3's fixtures are hand-reduced to the fields the reducer consumes**, with ids,
paths and counts replaced by constants. Never commit a captured stream verbatim.

*(Note: the "50 slash commands" figure recorded earlier in this file came from a
`--restricted` run. A normal session reports 242. The count is configuration-dependent
and nothing should be built on the number itself.)*

---

## Task 3 result — the reducer, and hooks turn out to be optional

**Done 2026-09-05.** `src/shared/session.ts` + `tests/session.test.ts`, 12 tests, written
failing first. 147/147 across the suite, typecheck clean.

`reduceSession(state, rawLine)` folds one stdout line into `SessionState` —
`sessionId`, `model`, `slashCommands`, `turns`, `activity`, `statusDetail`, `limits`.

Three properties it holds, each with a test and each earned from an earlier finding:

- **A second `init` keeps the transcript.** The task 2 trap, now a regression test.
- **An unchanged event returns the identical object.** `layout.ts` already learned that a
  reducer rebuilding state for a no-op makes a component reporting upward loop forever.
- **Nothing throws.** A malformed line costs that line, matching `parseLayout`'s posture.

### The open question from task 1, answered: hooks are not needed for activity

The reducer ignores hook events entirely and still produces a complete activity model —
`working` from `assistant` and `init`, `needsAction` from `post_turn_summary`, `idle`
from `result`, with `needsAction` outranking `result` because the human is still owed
something. **So the per-launch `--settings` file is not needed for the rail**, and
`hook-server.ts`, `hook-relay.mjs` and the settings file can all go.

**One thing still gates that: subagent visibility (M8).** The reducer as written does not
report subagents. Two candidate non-hook routes, neither verified:

- `assistant` events carry **`parent_tool_use_id`** — non-null plausibly marks a message
  produced inside a `Task` call, which is how the JSONL transcripts mark sidechains.
- `result` carries **`subagent_stats`**, though only at the end of a turn.

**Do not delete the settings file until one of those is confirmed to name the subagent**
the way `SubagentStart`'s `subagent_type` does today. That experiment belongs in task 4,
where a real session is being driven anyway and a `Task` call costs nothing extra to
observe.

---

## Task 4 result — the manager, and subagents without hooks

**Done 2026-09-05.** `src/main/agent-session.ts` (`AgentSessionManager`), the six IPC
channels, the preload bridge, `AgentLauncher.prepareSession`, and per-window wiring in
`index.ts` on the same create/close/shutdown paths as `PtyManager`. 154/154, typecheck
clean.

### The subagent gate is open: hooks are not needed at all

One run, forcing a subagent, answered what tasks 1 and 3 left open:

| signal | result |
|---|---|
| events carrying `parent_tool_use_id` | **5** — subagent traffic is identifiable live |
| `result.subagent_stats` | `{"spawned":1,"completed":1,"by_type":{"Explore":1}}` |

`by_type` names the subagent exactly as `SubagentStart`'s `subagent_type` does, and
`parent_tool_use_id` attributes messages live. **So `--settings`, the hook relay and the
hook server are all unnecessary for the native path** — `prepareSession` writes no
settings file, and the M8 feature survives the change.

Two caveats worth keeping. `subagent_stats` only arrives with `result`, at the end of a
turn, so live labelling has to come from the `Agent` tool call. And **the tool is named
`Agent`, not `Task`** — the run looked for `Task` and found none. Whether that call's
input carries `subagent_type` is unconfirmed; it costs nothing to check during task 5,
where real sessions run anyway.

### A defect the real stream found

Replaying the captured run through the reducer produced tools `["Agent","Glob","Glob"]`
on the main thread. The two `Glob` calls were the **subagent's**, arriving on the same
stream with `parent_tool_use_id` set, and folded in as though the top-level agent had
made them. Fixed with a failing test first: a message carrying `parent_tool_use_id`
advances activity but never becomes a turn.

Worth noting how it was found. Twelve hand-written tests did not catch it, because the
fixtures were written from a stream that had no subagent in it. **Real data found what
imagined data could not** — which is the argument for task 3's rule that fixtures come
from runs rather than from imagination, and an argument for replaying a real capture
through the pure layer whenever the stream gains a new shape.

### What is verified, and what is not

The reducer and `splitLines` are verified against a **real** stream, deliberately
re-chunked at 37-byte boundaries to break lines in awkward places. The manager's process
plumbing — spawn, stdin write, SIGINT, exit — is typechecked and reviewed but **has not
yet been executed**. Task 5 drives it from the UI, which is where it gets its first real
exercise; do not treat it as proven until then.

---

## Task 5 result — a turn, end to end, with no ConPTY in it

**Done 2026-09-05.** `AgentSession.tsx`, its styles, a `files:choose-files` channel for
attachments, and Claude panes dispatched to it in `App.tsx`. 154/154, typecheck clean.

**Verified by driving the real app**, not by reading: `+ Claude`, then a typed turn, then
a capture. The pane showed `You — Reply with exactly: hello from oikist` and
`Claude — hello from oikist`. That exercises the whole chain — composer, IPC, manager,
child process, stream-json, `splitLines`, `reduceSession`, render — so **the manager's
process plumbing is now executed rather than merely typechecked**, which is what task 4
said had to happen before it counted.

The four Q8 input complaints are answered by construction: a real `textarea` has a caret
and click-to-position, holds markdown, and sits next to attachment chips.

### What the first screenshot caught

The pane said **"Starting Claude…" indefinitely.** Readiness was being read off
`state.sessionId`, which only arrives with `init` — and `init` arrives *per turn*, so a
session nobody has spoken to emits nothing at all and the message could never clear.
Readiness now comes from the `start` promise resolving.

This is the task 2 finding biting from the other direction: knowing `init` is per-turn
prevented the reducer bug and still did not prevent this one, because the same fact has
a second consequence — **a fresh session is silent, so silence cannot mean "not ready".**

### `OIKIST_TYPE`

`OIKIST_CLICK` could reach the pane but not put anything in it, and a conversation has no
interesting state until someone speaks. `OIKIST_TYPE=<selector>::<text>` types and submits,
in the same spirit as the capture and click affordances already documented in `CLAUDE.md`.
It writes through React's own value setter — a plain `value =` assignment is swallowed by
React's descriptor and the component never sees the change.

### Known gaps, deliberately left

- **The rail still reads `State unknown` for a native session**, visible in the capture.
  Its activity comes from the launcher's map, which only hooks used to update, and the
  native path installs no hooks. Task 7 connects it to `post_turn_summary`.
- **Slash-command autocomplete is empty until the first turn**, because that is when
  `init` first arrives. A property of the stream, not worth faking with a guessed list.
- **Attachments are sent as `@path` references**, which the agent reads with its own
  tools. No file content passes through oikist and nothing is uploaded. Image attachment
  via `codex exec -i` is task 6.
- **Codex panes still use the pty**, since task 6 has not verified its stream.

---

## Task 6 result — Codex, and a second session model

**Done 2026-09-05.** `reduceCodex`, a two-strategy `AgentSessionManager`, `+ Codex` panes
dispatched to the native view. 162/162, typecheck clean. Quota was checked *first*, per
the section 6 hazard: 89% of the five-hour window and 71% of the weekly, so this was done
in four small runs rather than by iterating.

### The event vocabulary, from capture

```
thread.started   { thread_id }              <- the session identity
turn.started
item.completed   { item: { id, type, text|message } }
turn.completed   { usage: { input_tokens, cached_input_tokens, output_tokens, … } }
turn.failed      { error: { message } }
```

Item types observed: `agent_message` (what Codex said) and `error` (non-fatal warnings —
a shortened skill budget, missing model metadata). Others certainly exist; unobserved
types are ignored rather than guessed at.

### Codex runs one process per turn

The spike resized the task, as the plan allowed. **`codex exec` takes one prompt and
exits** — there is no `--input-format stream-json` and no long-lived pipe. Continuity
comes from `codex exec resume <thread_id>`, verified: resuming returned the same thread
id and the model still remembered the previous turn.

So the manager now carries two strategies. Claude: one child for the conversation, turns
written to stdin. Codex: **no child at all between turns**, one spawned per turn, and a
process exiting is the end of a *turn* rather than of the session. That distinction is
the `endsSession` flag in `#attach`.

**`stdin` must be closed immediately** on a Codex turn. With it open, `codex exec` waits
for more input and the turn never starts — which cost a run to discover.

### The model is deliberately not overridden

This machine's `~/.codex/config.toml` pins `gpt-6-astra`, which the installed CLI
(`codex-cli 0.149.0`) cannot run: every turn fails with *"requires a newer version of
Codex"*. oikist **passes no `-m` override**. Hard rule 4 is about not changing how Codex
behaves, and quietly substituting a different model than the user chose is exactly that.
The pane shows the real error instead, which is actionable; a silent substitution would
not be.

*(An environment note rather than a defect in this repo: that config will fail in any
Codex client on this machine until the CLI is upgraded or the model changed.)*

### Two defects the captures found

**A failed Codex turn was completely silent.** `statusDetail` was rendered only when
activity was `needsAction`, but `turn.failed` sets the detail and goes `idle` — so the
pane showed the question and nothing else. It now renders whenever the agent has
something to say about its own state. Found by looking at a screenshot with an empty
pane, not by a test.

**The failure was a JSON envelope.** Codex nests the real sentence as a JSON *string*
inside `turn.failed.error.message`, so the pane filled with a dump. `unwrapCodexError`
extracts the sentence and leaves anything of another shape untouched.

### And one self-inflicted one, worth recording

The Codex spawn code was written through a heredoc and `"\n"` arrived in the file as a
literal newline inside a string, breaking the build. **`CLAUDE.md` documents this exact
trap** — backslashes lose a level of escaping through the Bash tool, quoted heredocs
included — and says to use the editor for backslash-bearing literals. The rule was
written down, and walked into anyway.

---

## Task 7 result — the rail, the limits, and a handoff that stays supervised

**Done 2026-09-06.** 164/164, typecheck clean, verified by capture.

**The rail is live again.** `AgentSessionManager.onState` reports reduced state outward;
`AgentLauncher.applySessionState` updates the row and returns whether anything actually
changed, so a stream that keeps saying the same thing costs no re-render. The capture
shows a launched session reading `Working` while the attached one still reads
`State unknown ~attached` — hard rule 7's distinction intact, and now with hooks gone
entirely from that path.

`railActivity` is the translation, and two of its choices are deliberate:

- `starting` becomes **`unknown`**, not `idle`. A session nobody has spoken to has said
  nothing, and `idle` would be a claim.
- `needsAction` becomes **`waitingForInput`**, not `needsPermission`. `post_turn_summary`
  says the human is needed; it does not say a permission prompt is open.

**Claude's limits are no longer blank.** Section 6 and M7 both recorded that Claude
publishes nothing readable, so the handoff view showed exact Codex numbers against
nothing. `rate_limit_event` supplies five-hour and seven-day utilisation, cached as it
arrives. Until an agent has actually run, the row says *why* it is empty rather than
reporting a zero, which would read as "plenty left".

**Handoff hands over without sending.** `Open in <provider>` opens a pane for the
receiving agent with the block already in its composer, and stops. The clipboard round
trip was doing two jobs — moving the text, and forcing someone to read it before it
went — and only the first is obsolete now that both agents live in one window. Copy stays
for handing off to something outside it.

The pending text is held in `App`, keyed by pane id, and **never in the layout**: a
handoff block restored days later, still unsent, would be worse than no handoff at all.

---

## Task 8 result — the hook path is gone, and M8 was rebuilt first

**Done 2026-09-06.** 142/142, typecheck clean, app still exits under `OIKIST_CLOSE_TEST`,
a live turn verified after the deletion.

### It could not be a deletion, because a feature was already broken

Task 5 routed every `pane.agent` pane to the native view, which made the pty agent launch
unreachable — the `agent` prop on the terminal branch can no longer be set. **So hooks
had been firing for nothing since task 5, and M8's subagent display was already dead.**
A regression introduced two tasks earlier and noticed only when this one went looking.

Deleting the relay at that point would have looked like the cause. **M8 was rebuilt on
the stream first**, with five failing tests written before the code.

### Subagents, on the stream

- The launching tool is **`Agent`**, not `Task`. A probe searching for `Task` found none
  while a subagent was demonstrably running (task 4).
- Its `input.subagent_type` carries the label; when absent the tool's own name is used
  rather than a label being invented.
- The subagent's own messages carry `parent_tool_use_id`, and are kept out of the main
  transcript — folded in, they show its tool calls as the top-level agent's.
- A subagent is retired when **its own** `tool_result` returns, tracked by id, so two
  running at once do not stop each other's. Any still marked running are cleared at
  `result`, since a turn that ended cannot still be delegating.

### Deleted

`src/main/agents/hook-server.ts`, `resources/hook-relay.mjs`, `src/shared/hooks.ts`,
`AgentLauncher.prepare` / `prepareCodex` / `applyHookEvent` / `sweepStaleSettings` /
`dispose` / `#resolveNode`, the launcher's endpoint and token, the `ptyCreate` agent
branch, the pty-to-session bookkeeping, and three test files.

The launcher went from 300 lines to 116. With them go the ephemeral loopback listener,
the per-run bearer token, the per-launch settings file, the stale-settings sweep, and the
trap that the relay had to be run by a separately-resolved real `node` because
`process.execPath` is `electron.exe`.

**A pty is a shell now, and only a shell.**

### Documentation corrected rather than left to rot

`CLAUDE.md`'s "How agent state reaches the app" described the relay in detail and would
have been actively misleading. Its trap list swapped the real-Node trap for the three
this phase actually cost: `init` is per turn, a fresh session is silent, and `codex exec`
needs its stdin closed. `electron-builder.yml` still turns `asar` off — **node-pty's
binding is reason enough on its own**, and the comment no longer cites a relay that does
not exist.

---

## Architecture

**One `AgentSession` per pane, in main.** Owns a child process, parses stdout JSONL into
typed events, keeps the turn list, and pushes deltas to the renderer. It replaces the
pty for agent panes only. Shell panes keep `pty.ts` untouched.

**Domain stays pure and TypeScript.** Event-to-state reduction goes in
`src/shared/session.ts` as pure reducers alongside `layout.ts`, with the same discipline:
no Node, no Electron, no I/O, fully unit tested, and never ported to Rust (hard rule 2).
Parsing untrusted stdout follows `parseLayout`'s posture — **repair and drop, never
throw.** A malformed line must cost that line, never the session.

**New IPC**, added to `src/shared/ipc.ts` in the existing style:

| Channel | Direction |
|---|---|
| `session:start` | renderer → main |
| `session:send` | renderer → main (a user turn) |
| `session:interrupt` | renderer → main |
| `session:dispose` | renderer → main |
| `session:event` | main → renderer (one reduced delta) |
| `session:exit` | main → renderer |

**Renderer:** `AgentSession.tsx` replaces `TerminalPane` for agent panes — a turn list
plus a composer. `Terminal.tsx` is untouched and keeps serving shells.

### What this deletes

`src/main/agents/hook-server.ts` (127 lines) and `resources/hook-relay.mjs`. **Task 1
confirmed state arrives inline** — and with them the ephemeral loopback listener, the
per-run bearer token, and the trap that the relay needs a separately-resolved real `node`
because `process.execPath` is `electron.exe`.

**The per-launch `--settings` file survives**, contrary to the first draft of this plan:
task 1 showed hook events fire only for *configured* hooks, so something must configure
them. What changes is that its commands become no-ops. It drops out entirely only if
task 3 finds `tool_use` and `post_turn_summary` sufficient on their own.

**Delete in a commit of its own, after the replacement works.** Not alongside it.

---

## Tasks

Ordered. Each is independently verifiable; do not start one before its predecessor is
seen working.

1. ~~**Prove `--include-hook-events`.**~~ **Done 2026-09-05. See *Task 1 result* below.**
2. ~~**Prove multi-turn `--input-format stream-json`.**~~ **Done 2026-09-05. See *Task 2
   result* above.** The process survives; `AgentSession` owns a long-lived child.
3. ~~**`src/shared/session.ts` — pure reducers, TDD.**~~ **Done 2026-09-05. See *Task 3
   result* above.** 12 tests, written failing first; hooks proved unnecessary for
   activity, with subagents the one open gate.
4. ~~**`AgentSession` in main + the six IPC channels.**~~ **Done 2026-09-05. See *Task 4
   result* above.** Hooks proved unnecessary for subagents too. Original:
   `launcher.ts`'s absolute-path resolution — node-pty does not search PATH, and neither
   should this.
5. ~~**`AgentSession.tsx` — turn list and composer.**~~ **Done 2026-09-05. See *Task 5
   result* above.** Verified by driving a real turn in the app. Original:
   a real `textarea` with a caret, click-to-position, markdown input, attachment chips,
   and slash-command autocomplete from `init.slash_commands`.
   **Watch the effect-dependency trap.** It has bitten three times, most recently with
   `resumeSessionId` relaunching agents. Anything that round-trips through the parent
   goes in a ref, out of the deps.
6. ~~**Codex.**~~ **Done 2026-09-05. See *Task 6 result* above.** One process per turn,
   resumed by thread id. Original:
   attachments. Shape unknown — treat task 6 as a spike that may resize itself.
7. ~~**Rail and handoff.**~~ **Done 2026-09-06. See *Task 7 result* above.** Original:
   `rate_limit_event`, making the handoff view symmetric. Handoff pre-fills the target
   composer **unsent** — section 10, and the fence's ban on unsupervised agent-to-agent
   messaging.
8. ~~**Delete the hook relay.**~~ **Done 2026-09-06. See *Task 8 result* above.** It could
   not be a plain deletion: M8 had to be rebuilt on the stream first.

---

## Rules that apply and will be easy to forget

- **Hard rule 7 still governs.** A launched session over stream-json is `certain`.
  Anything read from the JSONL transcript files is `confident`. Never flatten them.
- **Hard rule 6.** Restore stays dormant. A native agent pane must restore as a card
  that resumes on a click, exactly as the terminal one does.
- **Hard rule 4.** No writes to `~/.claude/settings.json`. Per-launch settings only.
- **Transcript files are conversation content.** mtime, size and message type only.
  Never the text. (Section 10.)
- **Do not touch `pty.ts`.** Switch-bar item 1 is still a requirement and shells still
  need it. This phase adds a pane type; it does not remove one.

---

## Done

- An agent pane runs a real Claude session with no ConPTY involved.
- All four Q8 input complaints are gone: caret, click-to-position, markdown, attachments.
- The rail shows activity from `post_turn_summary`, tagged `certain`.
- Handoff shows Claude's limits next to Codex's.
- `npm run verify` green; the app still exits (`OIKIST_CLOSE_TEST`).

Then **step 3 — the workday test against VS Code.** It is a gate. If the extensions still
win, stop and re-plan rather than starting step 4.
