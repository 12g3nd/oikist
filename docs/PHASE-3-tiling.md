# Phase 3 — tiling, and getting a pane out of the way

Step 2 of the `DECISIONS.md` section 12 roadmap. Section 5 holds the reversal and why.

Day 2, finding 1: *"the windows feel rigid, I miss the modularity of the window panes of
Wave."* Finding 3, second half: *"I miss how Wave lets me temporarily maximize a window."*
**Those are one feature.** Arranging panes is only survivable on a 14-inch screen if you
can also collapse everything to one.

---

## The budget

Section 1 measured Wave's tiler at **~4,100 lines** and used it as a reason not to fork.
Nothing here should approach that. The difference is what is *not* being built:

**In:** binary splits in either direction, nested, resizable, with temporary maximise.

**Out, deliberately** — this is where Wave's 4,100 lines actually go: dragging a pane from
one split into another, dragging between tabs, tab bars inside panes, magnification
animation, and layout presets. If any is missed after a week of use, it gets its own
entry the way tiling got section 5's.

---

## The model

**The flat pane list stays. Arrangement becomes a separate tree keyed by pane id.**

```ts
type Arrangement =
  | { kind: "leaf"; paneId: string }
  | { kind: "split"; direction: "row" | "column"; ratio: number; children: [Arrangement, Arrangement] };
```

`TabState` gains `arrangement: Arrangement` and `maximizedPaneId?: string`. `panes` keeps
holding the pane *content* exactly as it does now.

### Why not a tree of `PaneState`

The obvious design — nest `PaneState` directly in the tree — was rejected for three
reasons, all of which are about the code that already exists:

1. **Every existing reducer keeps working.** `setPaneSession`, `setPanePath`, `wakePane`
   and `activeCwd` all map over `tab.panes`. A tree of panes rewrites all of them; a tree
   of *ids* rewrites none.
2. **Migration is one line.** A stored layout from before this change has no
   `arrangement`; it is synthesised from the flat list. No version bump, no migration
   step that can fail halfway.
3. **`parseLayout` can repair it.** Its whole posture is that stored state is untrusted —
   it drops duplicates, repairs dangling ids and never throws. With two structures that
   have to agree, that becomes: **prune leaves whose pane is gone, append panes the tree
   forgot.** A corrupt arrangement then costs the arrangement, never the panes, and never
   the ability to open the app. A tree holding the panes themselves has no such fallback,
   because losing the tree loses the content.

`MAX_PANES_PER_TAB` rises from 2 to **8** rather than disappearing. The cap is what stops
a corrupt file from producing a thousand panes, and it was never really about screen size.

---

## Tasks

1. **`Arrangement` reducers in `layout.ts`, TDD.** `splitPane(tabId, paneId, direction)`,
   `closePane`, `setRatio`, `toggleMaximized`, plus `arrangementFor` to synthesise one
   from a flat list. Domain layer: failing test first.
2. **`parseLayout` repair.** Prune, append, clamp ratios into a sane band, and drop a
   `maximizedPaneId` naming a pane that no longer exists. Fuzz it with the existing
   untrusted-input tests as the model.
3. **Rendering.** ~~One component walking the tree into nested flex boxes~~ — **this was
   wrong, see the result below.** Nesting is exactly what moves a pane in the React tree.
   Panes must keep their identity across re-arrangement so a running agent is never
   remounted — **this is the one that can silently kill a session**.
4. **Maximise.** Render only the maximised leaf; everything else stays mounted and hidden.
   `[hidden]` needs `display: none !important` here, for the reason already in
   `CLAUDE.md` — a hidden pane that keeps rendering is how the terminal bug happened.
5. **Keyboard.** Split right, split down, close pane, toggle maximise. The existing
   `Ctrl+Shift+E` split and `Ctrl+Shift+W` close keep their meanings.

---

## The trap to watch

**A pane must not remount when the tree changes.** React reconciles by position, and a
split turns `[A]` into `[[A, B]]` — a different position for A. If A is an agent pane, a
remount tears down its session and starts a new one, which spends quota and loses the
conversation.

Keying every leaf by `pane.id` is necessary but **not sufficient**: the panes must also
stay in the same component subtree. This is the same class of defect as the effect
dependency trap already recorded three times in `CLAUDE.md` — a re-render doing work that
looks like state.

Verify it the way the other one was: split a running agent pane and check the `claude`
process count is unchanged, rather than by reading the code.

---

## Done

- A pane splits in either direction, nests, and resizes by dragging.
- Any pane maximises and restores without changing the arrangement.
- A stored layout from before this change opens, arranged as it was.
- A corrupt arrangement costs the arrangement and nothing else.
- **Splitting a running agent does not restart it**, verified by process count.
- `npm run verify` green; the app still exits.

---

## Result — 2026-09-06

Tasks 1-5 done. 162/162, typecheck clean.

**The renderer does not nest, which is how the remount trap was removed.** Task 3 above
called for nested flex boxes; that was the wrong design and was abandoned during the work.
`layoutRects` turns the tree into flat rectangles instead, and the panes render as one
absolutely positioned list. Splitting changes styles and never DOM structure, so a pane
cannot move in the React tree and therefore cannot be remounted. **The trap is gone by
construction rather than by remembering to avoid it** — which is worth more than being
careful, because care is what failed the three previous times this class of defect landed.

**Verified by measurement, and the first measurement was invalid.** Counting `claude`
processes before and after the run showed 14 and 14 — meaningless, because the app quits
after the capture and disposes its sessions, so "after" was sampled once the agent was
already dead. Sampling *during* the run gave 15 / 15 / 16, and the 16 was noise: this
machine runs Claude Code, so the process count drifts on its own.

What settled it was **identity rather than count**. The pane started PID 30548, and 30548
was still alive after the split:

```
agent PID started by the pane: 30548
PASS - the agent process survived the split; no remount
```

A restart would have killed that pid and made a new one, so identity is immune to the
background noise a count cannot separate. This is the third time in this project that a
number was believed before the instrument was.

### Two things added along the way

**`OIKIST_CLICK` takes a sequence**, separated by `;;`, with `OIKIST_CLICK_GAP` between
steps. Proving a split does not restart an agent needs two actions and the affordance
only did one.

**Panes have edges.** Absolutely positioned panes abut with no seam, which is day 2's
"too flat" in miniature. A border and radius per pane, accent on the focused one — most
of what makes a tiled layout legible is being able to see where a pane ends.

### Still open

- The agent pane's transcript is cramped in a short pane: the composer keeps its height
  while the scroll area collapses. Visible in the capture, and a step 3 concern.
- Dividers are invisible until hovered. Deliberate for now; revisit with step 3's look.
