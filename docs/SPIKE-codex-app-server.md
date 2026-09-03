# Spike M0.5 — `codex app-server`

**Ran:** 2026-09-03 · **Codex CLI:** 0.149.0 (`0.149.0-alpha.4.1` in session records)
**Question:** does Codex expose session state programmatically, and does Phase 3 Task 9
(the Codex hook installer) still need to exist?

**Answer: no, it does not. Task 9 is cut.** The app-server supersedes it, and supplies
several other things the plan intended to derive by hand.

---

## It works on Windows, over stdio

`codex app-server` runs as a child process speaking line-delimited JSON-RPC on
stdin/stdout. Verified live:

```
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{...},"capabilities":null}}
<- {"id":1,"result":{"platformFamily":"windows","codexHome":"C:\\Users\\SJ\\.codex",...}}
```

**But `codex app-server daemon` is Unix-only.** Running any daemon lifecycle command
returns:

```
Error: codex app-server daemon lifecycle is only supported on Unix platforms
```

Consequences, and this is the one real limitation the spike found:

- oikist must **spawn and own its own app-server process**. There is no shared local
  daemon to connect to on Windows.
- `codex agents`, which browses "all agent sessions on the shared local app-server
  daemon", is therefore of little use here.
- An app-server instance only knows about threads *it* has loaded.
  `thread/loaded/list` returned `[]` while a separate Codex session existed elsewhere.

**Revision to the launch model: for Codex, own-first is effectively own-only.**
Live state for an externally-started Codex TUI is not reachable on Windows. Past
sessions remain fully readable (see `thread/list` below), so attach degrades to
history rather than disappearing — but it must be labeled honestly in the rail.

## The attention model is already a typed enum

```ts
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type ThreadStatus =
  | { type: "notLoaded" } | { type: "idle" } | { type: "systemError" }
  | { type: "active", activeFlags: Array<ThreadActiveFlag> };
```

Pushed as `thread/status/changed`. Phase 3 spent a plan deriving exactly these two
states from transcripts, hooks, and PID heuristics. Codex publishes them.

Approvals arrive as server-to-client **requests**, not inferences —
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`. A request that has
not been answered *is* the attention state, with no confidence scoring required.

Turn boundaries come from `turn/started` / `turn/completed`; tool-level granularity
from `item/started` / `item/completed`.

## Rate limits are exact, not parsed

```ts
export type RateLimitWindow = {
  usedPercent: number, windowDurationMins: number | null, resetsAt: number | null
};
```

Available as a request (`account/rateLimits/read`) and as a push
(`account/rateLimits/updated`). Live response during the spike:

| Window | Duration | Used | Resets |
|---|---|---|---|
| primary | 300 min (5h) | 0% | Sep 3, 2026, 11:03 |
| secondary | 10,080 min (7d) | **100%** | Sep 6, 2026, 23:34 |

Also carried: `planType`, `credits.balance`, `spendControlReached`, and
`rateLimitReachedType: "rate_limit_reached"`.

**This obsoletes error-text parsing for Codex.** The routing feature can read exact
percentages and reset timestamps for both windows. Claude still needs the reactive
parse plus manual override until an equivalent is found on that side.

## `thread/list` supplies the whole Sessions feature

Returned 25 threads, each carrying:

```
id · sessionId · preview · name · cwd · status · path (rollout .jsonl)
gitInfo { sha, branch, originUrl } · source ("vscode") · cliVersion
createdAt · updatedAt · recencyAt · forkedFromId · parentThreadId
```

`gitInfo.branch` and `cwd` are precisely the "working state" half of the handoff
payload, already structured. This is what `wave-devtools` currently reconstructs by
parsing rollout JSONL by hand.

## Also relevant, unplanned for

| Notification | Why it matters |
|---|---|
| `turn/diff/updated` | Live aggregated unified diff for the turn — the other half of the handoff payload |
| `thread/tokenUsage/updated` | Token accounting per turn, for routing decisions |
| `thread/queue/changed` | Pairs with `codex queue --thread <id> --message <text>` — the handoff injection primitive |
| `thread/name/updated` | Codex names threads itself; no title generation needed |
| `item/reasoning/*` | Reasoning stream, if a pane ever wants to show it |

## Generating the bindings

```
codex app-server generate-ts --out <dir>
codex app-server generate-json-schema --experimental --out <dir>
```

94 TypeScript files, `ts-rs`-generated. Check them in and regenerate on Codex
upgrades; a diff on this directory is the upgrade's changelog.

## Caveats

- The whole surface is marked **[experimental]**. Pin the Codex version, check the
  generated bindings into the repo, and treat a binding diff as a breaking-change
  alarm rather than discovering it at runtime.
- The Unix-only daemon may become cross-platform later. Revisit attach for Codex if
  it does.

## Rulings

1. **Phase 3 Task 9 (Codex hook installer) is cut.** Superseded entirely.
2. **Codex is own-only** on Windows for live state; history stays available via
   `thread/list` and must be labeled as history, not live.
3. **Rate limits for Codex are read from the API**, not parsed from error text.
   Claude keeps the reactive parse and the manual override.
4. **Generated bindings are checked in**, and pinned to a Codex version.
5. `wave-devtools`' Codex session adapter is superseded but **not** rewritten — it
   works, and that project is frozen after Phase 3.
