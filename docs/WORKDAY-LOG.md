# Workday log

The other half of done:

> All six switch-bar items work, **and oikist has been used for one full workday without
> reaching for VS Code and its agent extensions.**

**The criterion changed on 2026-09-05.** Day 1 met the old one — Wave was never opened —
and lost the work to VS Code anyway, which means it had named a competitor that had
already stopped being one. A test whose failure condition cannot occur is not a test.

This file is the instrument for that. The tests cannot find what a day of real work
finds, so the point is to write friction down *as it happens* rather than remember it
afterwards — the small annoyances are the ones that get rationalised away by evening and
are exactly the ones that decide whether a tool gets used.

## How to run it

```
npm run build
npm run app
```

## What to write down

Anything that made you pause, retype, or reach for Wave. Especially:

- **A moment you nearly opened Wave**, and what for. This is the most valuable entry
  there is — it names the gap precisely.
- **Anything done more than twice** — a repeated `cd`, a repeated click. Repetition is a
  missing feature wearing a disguise.
- **Anything believed wrongly.** A rail row that said the wrong thing, a state that
  lagged. Trust is the whole product; a status panel is worth nothing the day it is
  wrong.
- **Anything slow enough to notice.** Not benchmarked — noticed.

Not worth logging: things already on the v1 fence in `DECISIONS.md`. Wanting a command
palette is not a finding; it is a decision already made.

## Verdict

At the end of the day, one of:

- **Passed** — a full day, VS Code's agent extensions unopened.
- **Failed, with a reason** — what sent you back, named specifically.

A day that ends with "mostly fine" is a fail. If the honest answer is that the extensions
got opened, believe the behaviour rather than the checklist.

---

## Log

<!-- date · what happened · what it cost -->

### Day 1 — 2026-09-04

Started 11:14 on `a3d7a62`, with working directories landed that morning. Opened with a
single home shell tab, so the first action of the day is picking a project from the
directory chip.

- 11:14 · started · —
- 11:20-12:30 · three relaunches to pick up fixes · the morning went to fixing the tool
  rather than using it. Two defects found and fixed: every pane started in the home
  directory, and tabs were named for their kind so several read `claude`. Both were
  found by looking at the app, not by using it — they are pre-test findings, and the
  usage clock effectively starts at 12:30.
- 12:30 · relaunched on the current build · closed on the normal window path; the shell
  it owned was disposed rather than orphaned.
- 13:48 · **the directory chip has gone unused.** Two tabs open after 1h20m — a shell and
  a Claude agent — both still starting in the home directory, so both tabs are titled
  for their kind. The morning's two fixes are both in the build and neither is doing
  anything, because both depend on an explicit action that has not been taken. Open
  question: was the chip not noticed, or not needed?

### Day 2 — not yet run

Prepared 2026-09-06, on `a186e93`, after phase 2 (`docs/PHASE-2-native-agent-view.md`).
Agent panes are conversations rather than terminals; this is the day that says whether
that was the right diagnosis of day 1.

**What changed since day 1, and so what is actually being tested:**

- Claude and Codex panes have a real composer — caret, click-to-position, markdown,
  attachment chips, slash-command autocomplete. Four of day 1's seven complaints.
- The rail reports activity and subagents from the agents' own event streams.
- Claude's usage shows in the handoff view; handoff pre-fills the target composer unsent.
- The look is quieter: no tracking, sentence case.

**Not changed, and expected to still send you away** — these are steps 4-6, deliberately
not built until this day says the design is right:

- No session history. Reopening an old session is still not possible.
- No git. No diff of what an agent just changed.
- Editing still means opening VS Code.

Those three are the *known* gaps. The point of the day is what else turns up.

**Pre-flight, run 2026-09-06:**

| check | result |
|---|---|
| `npm run verify` | 142/142, typecheck clean |
| `npm run package` | `dist/win-unpacked/oikist.exe`, 224MB |
| app exits on window close | passes (`OIKIST_CLOSE_TEST`) |
| a Claude turn, end to end | passes |
| **restore, then resume** | **passes** — `--resume` carries context on the native transport |
| restore does not auto-launch | passes — restored agent panes stayed dormant |
| shell panes | pass |
| **Codex turns** | **fail — environment, not oikist.** See below |

**Codex will fail every turn until this is fixed.** `~/.codex/config.toml` pins
`gpt-6-astra`; the installed `codex-cli 0.149.0` cannot run it and returns *"requires a
newer version of Codex"*. This affects Codex everywhere on this machine, not just oikist.
oikist deliberately passes no `-m` override — substituting a model the user did not choose
would be exactly the kind of silent behaviour change hard rule 4 exists to prevent — so
the pane shows the real error. **Upgrade the CLI or change the model before the day
starts**, or Codex is untestable and half the handoff feature with it.

- HH:MM · started · —
