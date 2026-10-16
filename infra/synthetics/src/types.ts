/**
 * Shared shapes of the synthetic checks (Section 5.1, Monitoring) and the status page.
 */

/** Status page components (Section 5.1): one row per component and region. */
export const COMPONENTS = ["atlas", "gateway", "api", "realtime", "sync", "notifications"] as const;
export type ComponentId = (typeof COMPONENTS)[number];

/**
 * pass: answered correctly inside its latency budget. degraded: answered correctly but over budget.
 * fail: wrong answer, error or timeout. skipped: the check is not configured in this environment.
 */
export type CheckStatus = "pass" | "degraded" | "fail" | "skipped";

export interface CheckResult {
  readonly id: string;
  readonly component: ComponentId;
  readonly region: string;
  readonly status: CheckStatus;
  /** Milliseconds from request start to a verified answer; null when skipped. */
  readonly latencyMs: number | null;
  /** Machine-readable reason for any status other than pass. Never contains personal data. */
  readonly detail: string | null;
  /** ISO timestamp when the check started. */
  readonly at: string;
  /** Runbook section an alert for this check links to. */
  readonly runbook: string;
}

export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CheckContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly openWebSocket: (url: string) => WebSocketLike;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Values earlier checks in the same run produced, such as the synthetic user's access token. */
  readonly shared: Map<string, string>;
}

/** What a check's probe returns: ok, or the reason it is not. */
export type ProbeOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string };

export interface CheckDefinition {
  readonly id: string;
  readonly component: ComponentId;
  /** Environment variables the check needs; it is skipped when any is missing. */
  readonly requires: readonly string[];
  /** Latency budget in milliseconds; a correct answer slower than this is degraded. */
  readonly budgetMs: number;
  /** Required checks fail the run (and page on-call) when they fail. */
  readonly required: boolean;
  readonly runbook: string;
  probe(context: CheckContext): Promise<ProbeOutcome>;
}
