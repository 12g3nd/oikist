# Known issues

None open.

---

## Resolved

### The app did not exit when it quit

**Found and fixed at M3, 2026-09-03.**

Closing the window — or any call to `app.quit()` / `app.exit()` — left four Electron
processes running indefinitely, on every quit path, whether or not a terminal had ever
been opened.

**Cause.** The window's `closed` handler read `window.webContents.id`:

```ts
window.on("closed", () => {
  manager.disposeAll();
  ptyManagers.delete(window.webContents.id);   // throws: already destroyed
});
```

By the time `closed` fires the WebContents is destroyed, so that access threw. The
exception escaping the handler stopped `window-all-closed` from firing, so `shutdown()`
never ran and nothing ever asked the app to quit. **Fix: read the id once, when the
window is created, and close over it.**

### Why it took so long, and what to do differently

The cause was three lines of my own code. It took far longer than it should have, for
reasons worth not repeating:

**Measurement came last instead of first.** Three separate methods gave false readings
before any were validated: a wrapper command's exit code, `Process.WaitForExit`, and a
PID-based liveness check. PowerShell's `Start-Process` object reports `HasExited: True`
while child processes survive, and Windows reuses PIDs fast enough that an id lookup
finds an unrelated process. Only polling by process **name** against a pre-launch
baseline was trustworthy. Several conclusions drawn from the bad readings were wrong.

**Theories were implemented before they were tested.** node-pty's conout worker was
diagnosed, "fixed" with code reaching into private internals, and given a confident
explanatory comment — before any experiment had shown node-pty was involved. It was
not. The fix and the comment were both removed.

**`process.exit()` made things worse, not better.** It terminates the main process while
orphaning Electron's GPU and renderer children. Never use it here.

**Building a minimal control up was the slow direction.** Six separate control apps each
ruled out one suspect (bare Electron, a window, the `app://` protocol, ESM main, preload,
sandbox) and none of them found it. What actually worked, in two runs, was the opposite:
replace the real app's main with a minimal one *in the real project* — which exited,
proving the cause was in the main-process code and not the config — then add the real
code back in cumulative levels behind one env var. Level 3 exited, level 4 hung, and the
difference between them was three lines.

**One of the "ruled out" results was itself invalid.** An early bisect branch never armed
its window-close, so it "hung" simply because nothing had asked it to quit. A control
that cannot pass needs checking before its failure is believed.

The lesson, in order: validate the measurement, bisect the real thing downward, and do
not write a fix until an experiment has named the cause.

---

## Findings

### Claude 2.1.238 no longer reports activity in its live-session files

**Found at M4, 2026-09-03.**

`~/.claude/sessions/<pid>.json` on 2.1.238 carries identity only — `pid`, `sessionId`,
`cwd`, `startedAt`, `procStart`, `name` and similar. The fields `status`, `waitingFor`
and `statusUpdatedAt` are **gone**.

wave-devtools' `claude-live.ts` was written against 2.1.234 and depends on all three:
its `mapClaudeLiveStatus` exists to turn `waitingFor` into an activity, and
`resolveStatusUpdatedMs` orders records by `statusUpdatedAt`. **That entire poll-based
activity inference is dead on the current version**, which is why oikist takes identity
from `claude agents --json` — a supported, scriptable command — and will take activity
from hooks on agents it launches itself.

A good argument for the decision to stop scraping: the scraped fields disappeared within
four patch versions, silently, with no error. An agent panel built on them would simply
have started saying "idle" about everything.

### Discovery costs about a second per pass

`claude agents --json` spawns a Node process and took 0.8–1.5s across three runs on this
machine. It cannot poll at terminal speed, so discovery runs every 5s with single-flight
and exists only to notice sessions started outside oikist. Agents oikist launches will
report their own state through hooks, immediately, and that is the path that matters.

### Claude's full hook event list, and how to get it for free

**Found at M8, 2026-09-03.**

`claude doctor` reads settings from the current directory without a trust prompt, and
when it meets an unknown hook event it prints **every valid one**:

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch,
PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay
```

So the hook surface can be enumerated with zero tokens: drop a settings file containing
a deliberately bogus event into a scratch directory and run `claude doctor` there. An
unknown event is **ignored, not fatal**, so registering one that a future version drops
degrades quietly rather than breaking the launch.

Worth revisiting from that list: **`PermissionRequest`** is a dedicated event, which is
more direct than the `Notification` matchers currently used for permission prompts.
`FileChanged`, `CwdChanged` and `TaskCreated`/`TaskCompleted` are also unexploited.

### Subagent hooks fire, and name the subagent

Verified live rather than assumed. One print-mode session pointed at a throwaway
listener produced, in order:

```
session-start
subagent-start   label "Explore"
subagent-stop    label "Explore"
turn-end
session-end
```

So a pane can report *what* it is busy with, not merely that it is busy. The label comes
from `subagent_type` in the hook payload; it is the only payload field the relay
forwards, because everything else there is prompt or tool text.

---

### An agent pane closed itself, hiding why it stopped

**Found and fixed 2026-09-04.**

Clicking **+ CLAUDE** created a tab that vanished within seconds, leaving no trace. Two
defects, one hiding the other.

**The visible one:** `TerminalPane`'s `onExit` called `unsplitPane` unconditionally. For
a shell that is right — you typed `exit`. For an agent it threw away the pane whose
output *was* the error message. An agent pane now never removes itself; it keeps its
output and shows an exit notice with a **Start again** action.

**The one that fix revealed:** with the pane no longer disappearing, it showed
`No conversation found with session ID: 94451447-...`. The pane reports its new session
id upward, that comes straight back down as the `resumeSessionId` prop, and the prop was
in the effect's dependency array — so the effect re-ran and relaunched the agent with
`--resume` for a session created seconds earlier and never written to disk. Claude
exited, and the pane closed itself before anyone could read why.

**This is the third instance of the same defect** — a caller-supplied value in an
effect's dependency array. `onExit` recreated ptys at M3, `onPathChange` cleared the file
being read at M6, and `resumeSessionId` relaunched agents here. The rule in `CLAUDE.md`
now covers props as well as callbacks: if the value round-trips through the parent, hold
it in a ref and keep it out of the deps.

**Also corrected:** the first diagnosis of the vanishing tab was "Claude is out of
quota". It was not. The exit message deliberately no longer names a cause — it points at
the pane's own output, which is where the real one was all along.
