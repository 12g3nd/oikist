/**
 * Why is the batched pipeline slower than raw node-pty?
 *
 * Four consumers against the identical pty workload, in one process, with one idle
 * detector, so the only thing that varies is what the onData handler does. The earlier
 * comparison had raw node-pty in a plain .mjs process and PtyManager under tsx, with
 * different idle logic — which is not a comparison.
 *
 *   node --import tsx tests/batching.bench.mts <fixture>
 */
import { createRequire } from "node:module";

import { PtyManager } from "../src/main/pty.js";
import { IPC } from "../src/shared/ipc.js";

const require = createRequire(import.meta.url);
const nodePty = require("node-pty") as typeof import("node-pty");

const fixture = process.argv[2];
if (fixture === undefined) {
  console.error("usage: batching.bench.mts <fixture>");
  process.exit(1);
}

const FLUSH_MS = 8;
const MAX_PENDING = 4 * 1024 * 1024;

interface Result {
  readonly name: string;
  readonly bytes: number;
  readonly seconds: number;
  readonly emits: number;
}

/** One run: spawn, settle, stream the file, stop when output goes quiet. */
async function run(name: string, attach: (onChunk: (s: string) => void) => () => void): Promise<Result> {
  let bytes = 0;
  let emits = 0;
  let first = 0;
  let last = 0;
  let armed = false;

  const detach = attach((chunk) => {
    if (!armed) {
      return;
    }
    if (first === 0) {
      first = performance.now();
    }
    bytes += chunk.length;
    emits += 1;
    last = performance.now();
  });

  await new Promise((r) => setTimeout(r, 2500));
  armed = true;
  writeCommand(`type "${fixture}"\r`);

  while (first === 0 || performance.now() - last < 2000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  detach();
  await new Promise((r) => setTimeout(r, 500));

  return { name, bytes, seconds: (last - first) / 1000, emits };
}

let writeCommand: (data: string) => void = () => {};

/** A: baseline. Every pty read counted, nothing else done. */
function rawCounting(onChunk: (s: string) => void): () => void {
  const p = nodePty.spawn(process.env.COMSPEC ?? "cmd.exe", [], { cols: 200, rows: 50, useConptyDll: true });
  writeCommand = (d) => p.write(d);
  p.onData(onChunk);
  return () => {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  };
}

/** B: baseline plus string accumulation, but no timer. Isolates concatenation. */
function rawAccumulating(onChunk: (s: string) => void): () => void {
  const p = nodePty.spawn(process.env.COMSPEC ?? "cmd.exe", [], { cols: 200, rows: 50, useConptyDll: true });
  writeCommand = (d) => p.write(d);
  let pending = "";
  p.onData((chunk) => {
    pending += chunk;
    if (pending.length > MAX_PENDING) {
      pending = pending.slice(-MAX_PENDING);
    }
    onChunk(chunk);
  });
  return () => {
    pending = "";
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  };
}

/** C: accumulation plus the 8 ms flush timer. Isolates the timer. */
function rawBatched(onChunk: (s: string) => void): () => void {
  const p = nodePty.spawn(process.env.COMSPEC ?? "cmd.exe", [], { cols: 200, rows: 50, useConptyDll: true });
  writeCommand = (d) => p.write(d);
  let pending = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    timer = null;
    if (pending === "") {
      return;
    }
    const chunk = pending;
    pending = "";
    onChunk(chunk);
  };
  p.onData((chunk) => {
    pending += chunk;
    if (pending.length > MAX_PENDING) {
      pending = pending.slice(-MAX_PENDING);
    }
    if (timer === null) {
      timer = setTimeout(flush, FLUSH_MS);
    }
  });
  return () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  };
}

/** D: the real thing. */
function realManager(onChunk: (s: string) => void): () => void {
  const manager = new PtyManager((channel, payload) => {
    if (channel === IPC.ptyData) {
      onChunk((payload as { chunk: string }).chunk);
    }
  });
  let id = "";
  void manager.create({ cols: 200, rows: 50 }).then((created) => {
    id = created;
  });
  writeCommand = (d) => manager.write(id, d);
  return () => manager.disposeAll();
}

const variants: [string, (onChunk: (s: string) => void) => () => void][] = [
  ["A raw, count only", rawCounting],
  ["B raw + concat", rawAccumulating],
  ["C raw + concat + 8ms timer", rawBatched],
  ["D real PtyManager", realManager]
];

// Order is reversible because the OS file cache warms across runs: a monotonic
// improvement down the list would otherwise be indistinguishable from caching.
if (process.env.BENCH_REVERSE === "1") {
  variants.reverse();
}

const results: Result[] = [];
for (const [name, attach] of variants) {
  const result = await run(name, attach);
  // Printed as each finishes: a run this long must not lose everything to a timeout.
  console.log(
    `done ${result.name.padEnd(28)} ${(result.bytes / 1_048_576).toFixed(1)} MB in ${result.seconds.toFixed(1)}s, emits ${result.emits}`
  );
  results.push(result);
}

const baseline = results.find((r) => r.name.startsWith("A"))!.seconds;
console.log("");
for (const r of results) {
  const mb = r.bytes / 1_048_576;
  console.log(
    `${r.name.padEnd(28)} ${mb.toFixed(1).padStart(5)} MB  ${r.seconds.toFixed(1).padStart(5)}s  ` +
      `${(mb / r.seconds).toFixed(2)} MB/s  emits ${String(r.emits).padStart(7)}  ` +
      `${r.seconds === baseline ? "baseline" : `${(((r.seconds - baseline) / baseline) * 100).toFixed(0)}% vs A`}`
  );
}
process.exit(0);
