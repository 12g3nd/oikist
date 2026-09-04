/**
 * M0 arm A, half one: how fast the real pty pipeline consumes build output.
 *
 * Not a unit test — it is a measurement, run on demand, so it lives outside the suite.
 * Measures the actual PtyManager: pty read, the 8ms coalescing window, and the number
 * of IPC messages that batching produces for 500k lines of realistic build output.
 *
 *   node --import tsx tests/throughput.bench.mts <path-to-fixture>
 */
import { PtyManager } from "../src/main/pty.js";
import { IPC } from "../src/shared/ipc.js";

const fixture = process.argv[2];
if (fixture === undefined) {
  console.error("usage: throughput.bench.mts <fixture>");
  process.exit(1);
}

let bytes = 0;
let messages = 0;
let firstByteAt = 0;

const manager = new PtyManager((channel, payload) => {
  if (channel !== IPC.ptyData) {
    return;
  }
  const chunk = (payload as { chunk: string }).chunk;
  if (firstByteAt === 0) {
    firstByteAt = performance.now();
  }
  bytes += chunk.length;
  messages += 1;
});

const id = await manager.create({ cols: 200, rows: 50 });

// The shell must have finished printing its banner and be accepting input, or the
// command is written into a pty nobody is reading yet and is simply lost.
await new Promise((resolve) => setTimeout(resolve, 2000));
bytes = 0;
messages = 0;
firstByteAt = 0;
const started = performance.now();

// `type` streams the file through the shell exactly as a build tool would stream its
// output: many small writes, no flow control.
manager.write(id, `type "${fixture}"\r`);

// Idle detection: the run is over once no further output has arrived for a while.
let lastBytes = -1;
let quietFor = 0;
while (quietFor < 1500) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (bytes === lastBytes) {
    quietFor += 100;
  } else {
    quietFor = 0;
    lastBytes = bytes;
  }
}

const elapsed = performance.now() - started;
const streaming = performance.now() - firstByteAt - 1500;
const mb = bytes / 1_048_576;

console.log(`bytes received : ${mb.toFixed(1)} MB`);
console.log(`ipc messages   : ${messages}`);
console.log(`avg message    : ${(bytes / Math.max(1, messages) / 1024).toFixed(1)} KB`);
console.log(`time to first  : ${(firstByteAt - started).toFixed(0)} ms`);
console.log(`streaming time : ${streaming.toFixed(0)} ms`);
console.log(`throughput     : ${(mb / (streaming / 1000)).toFixed(1)} MB/s`);
console.log(`message rate   : ${(messages / (streaming / 1000)).toFixed(0)} msg/s`);
console.log(`total elapsed  : ${elapsed.toFixed(0)} ms`);

manager.disposeAll();
process.exit(0);
