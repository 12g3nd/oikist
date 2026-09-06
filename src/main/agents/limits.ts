import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { LimitWindow, ProviderLimits } from "../../shared/limits.js";
import type { SessionLimits } from "../../shared/session.js";

/**
 * What each provider has left.
 *
 * Codex answers exactly: `account/rateLimits/read` on its app server reports used
 * percentages and reset timestamps for both windows. Claude publishes nothing readable —
 * it has no usage subcommand — so its row says so rather than guessing, and the honest
 * options there are parsing a rate-limit error when one happens, or the user saying so.
 */

const REQUEST_TIMEOUT_MS = 12_000;

function readWindow(raw: unknown): LimitWindow | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.usedPercent !== "number") {
    return undefined;
  }
  return {
    usedPercent: value.usedPercent,
    windowMinutes: typeof value.windowDurationMins === "number" ? value.windowDurationMins : null,
    resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : null
  };
}

/**
 * Asks the Codex app server what is left.
 *
 * Spawned per query rather than held open: this is consulted when a handoff is being
 * considered, not continuously, and a long-lived child process is a thing to supervise.
 */
const run = promisify(execFile);

/**
 * Resolves an executable to an absolute path.
 *
 * Spawning with `shell: true` would concatenate arguments into a command line without
 * escaping them, which is the pattern this codebase avoids everywhere else — Node warns
 * about it directly (DEP0190). An absolute path plus an argument array cannot be
 * reinterpreted by a shell at all.
 */
async function resolveExecutable(name: string): Promise<string | null> {
  try {
    const { stdout } = await run("where", [name], { windowsHide: true, timeout: 5_000 });
    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith(".exe")) ?? null
    );
  } catch {
    return null;
  }
}

export async function readCodexLimits(): Promise<ProviderLimits> {
  const executable = await resolveExecutable("codex");
  if (executable === null) {
    return { provider: "codex", known: false, note: "Codex is not on PATH." };
  }

  return new Promise((resolve) => {
    const child = spawn(executable, ["app-server"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let settled = false;

    const finish = (limits: ProviderLimits): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(limits);
    };

    const timer = setTimeout(
      () => finish({ provider: "codex", known: false, note: "Codex did not answer in time." }),
      REQUEST_TIMEOUT_MS
    );

    child.on("error", () => finish({ provider: "codex", known: false, note: "Codex is not on PATH." }));

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      for (const line of out.split("\n")) {
        let message: { id?: number; result?: Record<string, unknown> };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id !== 2) {
          continue;
        }
        const rate = message.result?.rateLimits as Record<string, unknown> | undefined;
        finish({
          provider: "codex",
          known: rate !== undefined,
          ...(typeof rate?.rateLimitReachedType === "string" ? { reached: true } : { reached: false }),
          ...(typeof rate?.planType === "string" ? { plan: rate.planType } : {}),
          ...(readWindow(rate?.primary) === undefined ? {} : { primary: readWindow(rate?.primary)! }),
          ...(readWindow(rate?.secondary) === undefined ? {} : { secondary: readWindow(rate?.secondary)! })
        });
        return;
      }
    });

    const send = (value: unknown): void => {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "oikist", title: null, version: "0.0.0" }, capabilities: null }
    });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }), 900);
  });
}

/** Claude has no usage command, so this states that rather than inventing a number. */
/**
 * What Claude has left.
 *
 * There is still no usage subcommand — but a session driven over stream-json is sent
 * `rate_limit_event`, so the numbers exist for any agent oikist has actually run. Until
 * one has, this says so rather than reporting a zero that would read as "plenty left".
 */
export function claudeLimits(fromStream: SessionLimits | null): ProviderLimits {
  if (fromStream === null) {
    return {
      provider: "claude",
      known: false,
      note: "No Claude session has run yet. Its usage arrives on the session's own event stream."
    };
  }
  return {
    provider: "claude",
    known: true,
    reached: fromStream.fiveHour >= 1 || fromStream.sevenDay >= 1,
    primary: {
      usedPercent: Math.round(fromStream.fiveHour * 100),
      windowMinutes: 300,
      resetsAt: null
    },
    secondary: {
      usedPercent: Math.round(fromStream.sevenDay * 100),
      windowMinutes: 10080,
      resetsAt: null
    }
  };
}
