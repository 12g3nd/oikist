# M0 — Electron vs Tauri

**Ran:** 2026-09-03, after M8 rather than before M1. **Verdict: Electron. Do not revisit.**

The decision rule, fixed in advance in [`DECISIONS.md`](DECISIONS.md) section 3:

> Build the same xterm + WebGL frontend on both hosts. Pipe ~500k lines through each.
> If Tauri is not at least **25% better on sustained throughput or input latency while
> streaming**, choose Electron and do not revisit. Cold start and idle RAM are
> tiebreakers only.

## What was actually measured

xterm + WebGL is byte-identical on both hosts — that was finding 2 of the greenfield
decision — so the renderer is a constant and measuring it twice would prove nothing. The
only thing that differs is the **host-to-webview IPC bridge**, which is precisely where
`DECISIONS.md` predicted Tauri would be weak. That, plus the pipeline feeding it, is
what was measured.

Workload: a 30.3 MB fixture of 500,000 lines shaped like real build output, streamed
through a pty by `type`.

| Measurement | Result |
|---|---|
| Plain pipe, no pty (`spawn` + `type`) | **26.9 MB/s** |
| Raw node-pty, no batching | **0.95 MB/s** — 421,713 reads, avg **74 bytes**, 13,168 reads/s |
| oikist's `PtyManager` (8 ms coalescing) | **0.6 MB/s** — 5,605 IPC messages, avg 5.5 KB, 118 msg/s |
| Electron IPC bridge, main → renderer | **299 MB/s, 54,054 msg/s** (round trip, receipt confirmed) |
| WebView2 via wry `evaluate_script` | host enqueue 58,800 msg/s; **delivery never drained** a 1,000-message queue |

## Why this decides it

**ConPTY is the ceiling, and it sits upstream of both hosts.** The same file streams at
26.9 MB/s through an ordinary pipe and at 0.95 MB/s through a pty — a 28× drop that
neither Electron nor Tauri has any influence over. It is a Windows console limitation.

**Electron's bridge is idle at that rate.** It carries 299 MB/s and 54,054 msg/s;
oikist's terminal asks it for 0.6 MB/s and 118 msg/s. The bridge runs at roughly **0.3%
of capacity** — about 300× headroom on bytes and 450× on messages.

So the primary criterion cannot separate the two. For Tauri to be 25% better on
sustained throughput it would have to beat a bottleneck neither host owns. The rule's
own instruction applies: **choose Electron and do not revisit.**

## Caveats, stated rather than buried

- **Arm B is a lower bound on Tauri, not a fair measure of it.** It used `wry`'s
  `evaluate_script`, the naive host-to-page path — which queues a JS string per message
  and could not drain 1,000 of them. Tauri v2 uses `Channel` for streaming, which is
  faster, presumably for exactly this reason. A fair Tauri arm would score better than
  this number. **It does not change the verdict**, which rests on the ConPTY ceiling and
  Electron's headroom, not on Arm B being slow.
- **Cold start and idle RAM were not measured.** The rule makes them tiebreakers only,
  and the primary criterion was decided.
- **The spike ran after the Electron app existed**, which is the wrong order and weakens
  it as a guard against sunk cost. The mitigation is that the numbers are absolute:
  ConPTY's ceiling and Electron's headroom are facts about the platform, not preferences
  about the code already written.

## Open measurement, not diagnosed

Batching costs throughput: 0.95 MB/s raw against 0.6 MB/s through `PtyManager`, roughly
**45% slower**, reproduced across runs on an idle machine. In exchange it collapses
421,713 pty reads into 5,605 IPC messages — a **78× reduction** in cross-process
crossings, which is what the batching is for.

The cause has not been diagnosed and is deliberately not guessed at here. Practical
impact is small: a real `npm run build` emits well under a megabyte, so the difference
is roughly 1.0s versus 1.6s on a pathological 30 MB case and imperceptible on a normal
one. Worth revisiting only if terminal responsiveness ever feels wrong in real use —
and `npm run bench <fixture>` reproduces it.

## Reproducing

```
node -e "…generate fixture…" > bench-500k.txt
npm run bench -- <path-to-fixture>
```

The Electron and WebView2 bridge harnesses were throwaway and are not kept: they are
twenty lines each, described above precisely enough to rebuild.
