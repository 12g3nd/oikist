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
| Raw node-pty, no batching | **0.54-0.95 MB/s** — ~425,000 reads, avg **74 bytes** (slower than batched; see the correction below) |
| oikist's `PtyManager` (8 ms coalescing) | **0.6-0.8 MB/s** — ~5,400 IPC messages, avg 5.5 KB, ~120 msg/s |
| Electron IPC bridge, main → renderer | **299 MB/s, 54,054 msg/s** (round trip, receipt confirmed) |
| WebView2 via wry `evaluate_script` | host enqueue 58,800 msg/s; **delivery never drained** a 1,000-message queue |

## Why this decides it

**ConPTY is the ceiling, and it sits upstream of both hosts.** The same file streams at
26.9 MB/s through an ordinary pipe and at 0.5-0.95 MB/s through a pty — a 30-50× drop
that neither Electron nor Tauri has any influence over. It is a Windows console
limitation, and it is what every measurement below runs into.

**Electron's bridge is idle at that rate.** It carries 299 MB/s and 54,054 msg/s;
oikist's terminal asks it for under 1 MB/s and ~120 msg/s. The bridge runs at roughly
**0.3% of capacity** — some 300× headroom on bytes and 450× on messages.

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

## A correction: batching is not slower, it is faster

This document first claimed batching cost ~45% throughput, comparing 0.95 MB/s raw
against 0.6 MB/s through `PtyManager`. **That claim was wrong, and it was wrong for a
reason worth recording: it was not a comparison.** Raw node-pty ran in a plain `.mjs`
process; `PtyManager` ran under `tsx`; the two used different idle detection. Two
numbers produced by two harnesses say nothing about the code between them.

Rerun properly — four consumers, one process, one harness, one idle detector, varying
only what the `onData` handler does — and run in both orders to rule out the OS file
cache warming across variants:

| Consumer | forward (A→D) | reversed (D→A) | emits |
|---|---|---|---|
| **A** raw, count only | 52.1s | 56.7s | ~425,000 |
| **B** raw + string accumulation | 50.7s | 38.9s | ~75,000 |
| **C** B + the 8 ms flush timer | 42.1s | 47.7s | ~5,800 |
| **D** the real `PtyManager` | 39.7s | 48.2s | ~5,400 |

**A is the slowest variant in both orders**, whether it runs first or last, so position
and file caching do not explain it. On the mean of the two runs A is ~54s while B, C and
D are all ~44s.

**Why doing more work per read is faster.** The emit counts are stable across orders and
tell the story: A receives ~425,000 pty reads, B ~75,000, C and D ~5,400. A consumer
that returns instantly is handed many tiny reads; one that spends a moment lets
node-pty and ConPTY coalesce. At 425,000 reads the per-read overhead dominates the
actual byte handling, so fewer and larger reads win. Batching does not pay for its
message reduction — it is the reason the reads get bigger.

**Do not quote a precise percentage.** Run-to-run variance is large: B alone measured
38.9s and 50.7s, a 30% spread. The direction is consistent across both orders; the
magnitude is not. What is solid is the ordering (A slowest) and the emit reduction
(~73× fewer cross-process messages, 425,000 to 5,400).

`npm run bench` measures the pipeline; `node --import tsx tests/batching.bench.mts
<fixture>` runs the four-way comparison, and `BENCH_REVERSE=1` flips the order.

## Reproducing

```
node -e "…generate fixture…" > bench-500k.txt
npm run bench -- <path-to-fixture>
```

The Electron and WebView2 bridge harnesses were throwaway and are not kept: they are
twenty lines each, described above precisely enough to rebuild.
