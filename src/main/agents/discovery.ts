import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseClaudeAgents, type AgentSummary } from "../../shared/agents.js";

const run = promisify(execFile);

/**
 * How often attached agents are re-discovered.
 *
 * `claude agents --json` spawns a Node process and takes 0.8-1.5s on this machine, so
 * this cannot poll at terminal speed without a near-continuous process. It is the
 * fallback path: agents oikist launches will report their own state through hooks
 * immediately, and polling exists only to notice sessions started outside the app.
 */
export const DISCOVERY_INTERVAL_MS = 5_000;

/** Long enough for a cold start, short enough that a wedged CLI cannot stall discovery. */
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface DiscoveryResult {
  readonly agents: readonly AgentSummary[];
  /** False when the provider could not be consulted at all — not the same as "no agents". */
  readonly ok: boolean;
  readonly error?: string;
  readonly refreshedAt: string;
}

export type AgentsReader = () => Promise<unknown>;

/**
 * Reads live Claude sessions from the CLI.
 *
 * Invoked with an argument array and never a shell string, so nothing in the
 * environment can be interpreted as syntax.
 */
export const readClaudeAgents: AgentsReader = async () => {
  const { stdout } = await run("claude", ["agents", "--json"], {
    timeout: DISCOVERY_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(stdout) as unknown;
};

export interface DiscoveryOptions {
  readonly read?: AgentsReader;
  readonly intervalMs?: number;
  readonly onResult: (result: DiscoveryResult) => void;
}

export class AgentDiscovery {
  readonly #read: AgentsReader;
  readonly #intervalMs: number;
  readonly #onResult: (result: DiscoveryResult) => void;
  #timer: NodeJS.Timeout | null = null;
  #inFlight = false;
  #last: DiscoveryResult = { agents: [], ok: true, refreshedAt: new Date(0).toISOString() };

  constructor(options: DiscoveryOptions) {
    this.#read = options.read ?? readClaudeAgents;
    this.#intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
    this.#onResult = options.onResult;
  }

  get last(): DiscoveryResult {
    return this.#last;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
    // The poller must never be the reason the app stays alive.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Runs one discovery pass. Never throws and never overlaps itself.
   *
   * A failed read keeps the previously known agents rather than reporting an empty
   * list: "the CLI did not answer" and "you have no agents running" look identical to a
   * caller that only sees a list, and only one of them is worth acting on.
   */
  async refresh(): Promise<void> {
    if (this.#inFlight) {
      return;
    }
    this.#inFlight = true;
    try {
      const agents = parseClaudeAgents(await this.#read());
      this.#last = { agents, ok: true, refreshedAt: new Date().toISOString() };
    } catch (error) {
      this.#last = {
        agents: this.#last.agents,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 200) : "Claude could not be consulted.",
        refreshedAt: new Date().toISOString()
      };
    } finally {
      this.#inFlight = false;
    }
    this.#onResult(this.#last);
  }
}
