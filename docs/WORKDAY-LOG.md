# Workday log

The other half of done:

> All six switch-bar items work, **and oikist has been used for one full workday without
> opening Wave.**

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

- **Passed** — a full day, Wave unopened.
- **Failed, with a reason** — what sent you back, named specifically.

A day that ends with "mostly fine" is a fail. If the honest answer is that Wave got
opened, believe the behaviour rather than the checklist.

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
