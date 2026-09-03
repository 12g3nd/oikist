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
