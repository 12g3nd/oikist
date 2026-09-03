# Known issues

## The app does not exit when it quits

**Status:** open, unresolved. Found at M3, 2026-09-03.

Closing the window (or any call to `app.quit()` / `app.exit()`) leaves four Electron
processes running indefinitely — still alive 15+ seconds later, measured by polling
`Get-Process electron` rather than by any wrapper's exit code.

Shell cleanup is **not** implicated and is verified working: `cmd`/`OpenConsole` counts
return to their pre-launch baseline after a quit, so no terminal is orphaned.

### Ruled out, each by direct experiment

| Suspect | Test | Result |
|---|---|---|
| node-pty holding the loop open | Control build with `<TerminalPane>` removed entirely | **Still hangs** — not the pty |
| Quit method | `app.quit()`, `app.exit()`, and `process.exit()` all tried | All hang |
| Node event-loop handles | `process.getActiveResourcesInfo()` immediately before exit | `["MessagePort","Timeout","Timeout"]` — nothing held |
| Electron itself in this harness | Minimal app, no window | Exits in 3.2 s |
| A BrowserWindow | Minimal app with a window | Exits in 3.0 s |
| The `app://` custom protocol | Minimal app registering the scheme and serving over it | Exits in 3.4 s |
| ESM main process | Minimal app with `"type": "module"` and an ESM entry | Exits in 3.5 s |
| Renderer sandbox | Real app rebuilt with `sandbox: false` | Still hangs |
| Quitting during startup | `OIKIST_CLOSE_TEST` closes the window on the normal user path | Still hangs |

`process.exit()` is **worse** than the hang and must not be used: the main process
exits while orphaning Electron's GPU and renderer children.

### What is left to investigate

The difference between the minimal control (exits) and the real app (hangs) is now
narrow: the React/xterm renderer bundle, and the `show: false` plus `ready-to-show`
window pattern. Bisect from the real app downward rather than building the control up —
building the control up cost several rounds and ruled out only one suspect at a time.

### Impact

Real, and it blocks daily-driver use: quitting leaves processes behind that accumulate
across launches. It does not affect correctness while running — the terminal, IPC and
shell cleanup all work.

### Reproducing

```
npm run build
OIKIST_CLOSE_TEST=2500 npx electron .
```

Then poll for `electron` processes. Do not use a wrapper's exit code or
`Process.WaitForExit` to judge this: both reported false results during the original
investigation, because PowerShell's `Start-Process` object reports `HasExited: True`
while child processes survive, and PIDs get reused quickly enough to fool an id-based
check. Poll by process **name**.
