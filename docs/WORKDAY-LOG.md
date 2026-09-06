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
| **Codex turns** | **model blocker cleared; now quota-blocked until 03:39** |

**Codex, resolved and then re-blocked — 2026-09-06.**

The model problem is fixed: the CLI went `0.149.0` → **`0.153.4`**, and `gpt-6-astra`
now runs. `~/.codex/config.toml` was not touched, which is the right outcome — oikist
never passed a `-m` override, so upgrading the client was the only correct fix and it was
the user's to make.

It is now blocked on quota instead: the five-hour window reads **100% used, resets
03:39**; the weekly is at 73%. A Codex pane launches and reports the reason in plain
words — *"You've hit your usage limit… or try again at 3:39 AM"* — which is the task 6
error-rendering fix doing its job, and worth noting as the first time a real failure
arrived in the pane rather than silently.

**Own the cause: the verification runs spent it.** Codex sat at 89% of the five-hour
window before task 6, and task 6 plus today's two confirmations took the rest. This is
section 6's hazard repeating almost exactly — *"a provider being out of quota silently
shapes what gets built against it"* — except this time the quota went on proving the
integration rather than on building it. **Either start the day after 03:39, or start
before it and treat Codex as untested**, noting that the first Codex turn of the day is
also the first unrehearsed one.

**Ran 2026-09-06.** Six findings, in the author's words:

1. **The windows feel rigid.** *"I miss the modularity of the window panes of Wave."*
2. **The colour scheme should be orbit noir**, to match the desktop theme. *"I understand
   the theme, but I want it a little more modern. I really miss how Wave looked — like
   I'm a hacker, but this should make me look like a hacker, a little more glassy and
   modern."*
3. **No way to see what model is running.** *"How the hell am I supposed to know what
   model I'm using, effort, thinking, usage?"* Both CLIs show a status line and oikist
   shows none. Also: *"I miss how Wave lets me temporarily maximize a window."*
4. **One project at a time**, and *"it feels clunky to set up."*
5. **Too minimalistic.**
6. **No built-in web browser.**

### The shape of the verdict

**Five of the six are "oikist is not Wave."** Rigid panes, the look, temporary maximize,
one project at a time, and a web browser are all things Wave does and oikist deliberately
does not. Section 1 chose greenfield over forking Wave; section 5 cut the tiling engine
with the note *"add tiling later, against a working app, if it is ever actually missed."*
It has now been actually missed, by name, on the first day of real use.

**The criterion has named the wrong competitor twice.** Day 1 named Wave and lost the work
to VS Code. Day 2 named VS Code — and the screenshots from the day show a Wave-style
window with terminal/files/web/sysinfo/git/ports panes, plus lazygit. So the tool that
won the day was not the one the bar was written against, again.

That is worth more than any single item on the list: **a bar that has to be rewritten
after every attempt is not measuring anything.** The next one should name *whatever gets
opened instead*, without naming a product in advance.

### What the record already says about each

| finding | status in `DECISIONS.md` |
|---|---|
| rigid panes / tiling | **cut in section 5**, with an explicit "revisit if missed" clause. Fired. |
| orbit noir, glassier | theming came off the fence 2026-09-05; the *direction* is new |
| model / effort / usage | **not decided anywhere** — and mostly already in data oikist parses and discards |
| temporary maximize | never considered |
| one project at a time | **section 5's tab model assumed it**; never argued for |
| too minimalistic | new, and the hardest to act on as stated |
| web browser | **not on the fence at all** — new scope, and Wave-shaped |

### The cheap one, worth naming separately

Finding 3 is largely **already solved in data being thrown away**. `init` carries `model`
and `permissionMode`; `rate_limit_event` carries both usage windows; `result` carries
token usage. A status line per pane is mostly plumbing that already exists, not new
capability — unlike tiling, multi-project or a browser, each of which is real work.

**Verdict: not recorded yet.** The log demands passed or failed and the author has not
said which. The findings read as a fail, and the screenshots suggest another tool won the
day, but that is inference and the verdict is the author's to give.
