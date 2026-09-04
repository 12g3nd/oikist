/**
 * What each provider has left, as the renderer sees it.
 *
 * `known: false` is a first-class answer, not a failure: Claude publishes no usage
 * command, and saying so is more useful than a number that would be invented.
 */

export interface LimitWindow {
  readonly usedPercent: number;
  readonly windowMinutes: number | null;
  readonly resetsAt: number | null;
}

export interface ProviderLimits {
  readonly provider: "claude" | "codex";
  readonly known: boolean;
  readonly reached?: boolean;
  readonly plan?: string;
  readonly primary?: LimitWindow;
  readonly secondary?: LimitWindow;
  readonly note?: string;
}
