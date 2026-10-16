/**
 * The assistant conversation as a small store, shared by the Atlas panel and the Compass screen.
 * It has no UI and no framework: subscribe with `useSyncExternalStore(c.subscribe, c.getSnapshot)`.
 * Every state the surfaces render is named here, so both shells show the same loading, empty,
 * off, refused, no answer, error and confirmation states.
 */
import type {
  AssistantAnswerBody,
  AuroraClient,
  AuroraProblem,
  AuroraStatusResult,
  AuroraSuggestion,
} from "./client.ts";

/** Why the assistant cannot be used right now, or `ready`. */
export type Availability =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: AuroraStatusResult }
  | { readonly kind: "not-in-plan" }
  | { readonly kind: "off" }
  | { readonly kind: "limit-reached"; readonly allowance: number }
  | { readonly kind: "error"; readonly problem: AuroraProblem };

export type SuggestionPhase =
  "loading" | "proposed" | "confirming" | "applied" | "rejected" | "refused" | "error";

export interface SuggestionView {
  readonly id: string;
  readonly summary: string;
  readonly operationId: string;
  readonly phase: SuggestionPhase;
  readonly suggestion: AuroraSuggestion | null;
  readonly problem: AuroraProblem | null;
}

export type TurnPhase = "asking" | "answered" | "no-answer" | "failed" | "refused" | "error";

export interface Turn {
  readonly id: number;
  readonly question: string;
  readonly phase: TurnPhase;
  readonly answer: AssistantAnswerBody | null;
  readonly missing: string | null;
  readonly model: string | null;
  readonly problem: AuroraProblem | null;
  readonly suggestions: readonly SuggestionView[];
}

export interface ConversationState {
  readonly availability: Availability;
  readonly turns: readonly Turn[];
  readonly busy: boolean;
}

export function availabilityOf(status: AuroraStatusResult): Availability {
  if (!status.plan_includes_aurora) return { kind: "not-in-plan" };
  if (!status.enabled_features.includes("assistant")) return { kind: "off" };
  if (status.allowance !== null && status.used >= status.allowance) {
    return { kind: "limit-reached", allowance: status.allowance };
  }
  return { kind: "ready", status };
}

function suggestionPhase(s: AuroraSuggestion): SuggestionPhase {
  switch (s.suggestion_state) {
    case "Applied":
      return "applied";
    case "Rejected":
    case "Expired":
      return "rejected";
    case "Confirmed":
      return "confirming";
    default:
      return "proposed";
  }
}

export class AuroraConversation {
  private state: ConversationState = { availability: { kind: "loading" }, turns: [], busy: false };
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  private readonly client: AuroraClient;

  constructor(client: AuroraClient) {
    this.client = client;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConversationState => this.state;

  private set(next: Partial<ConversationState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private updateTurn(id: number, change: (turn: Turn) => Turn): void {
    this.set({ turns: this.state.turns.map((t) => (t.id === id ? change(t) : t)) });
  }

  private updateSuggestion(
    turnId: number,
    suggestionId: string,
    change: Partial<SuggestionView>,
  ): void {
    this.updateTurn(turnId, (t) => ({
      ...t,
      suggestions: t.suggestions.map((s) => (s.id === suggestionId ? { ...s, ...change } : s)),
    }));
  }

  async loadStatus(): Promise<void> {
    this.set({ availability: { kind: "loading" } });
    const result = await this.client.status();
    this.set({
      availability: result.ok
        ? availabilityOf(result.data)
        : { kind: "error", problem: result.problem },
    });
  }

  /** Earlier answered turns, oldest first, sent so follow-up questions keep their context. */
  history(): { question: string; answer: string }[] {
    return this.state.turns
      .filter((t) => t.phase === "answered" && t.answer !== null)
      .slice(-5)
      .map((t) => ({ question: t.question, answer: t.answer?.text ?? "" }));
  }

  async ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (trimmed === "" || this.state.busy) return;
    const id = this.nextId++;
    const history = this.history();
    const turn: Turn = {
      id,
      question: trimmed,
      phase: "asking",
      answer: null,
      missing: null,
      model: null,
      problem: null,
      suggestions: [],
    };
    this.set({ turns: [...this.state.turns, turn], busy: true });
    const result = await this.client.ask(trimmed, history);
    if (!result.ok) {
      const phase: TurnPhase = result.problem.status === 422 ? "refused" : "error";
      this.updateTurn(id, (t) => ({ ...t, phase, problem: result.problem }));
      this.set({ busy: false });
      if (result.problem.rule === "plan_limit_exceeded") await this.loadStatus();
      return;
    }
    const data = result.data;
    const suggestions: SuggestionView[] = data.suggestions.map((s) => ({
      id: s.suggestion_id,
      summary: s.summary,
      operationId: s.operation_id,
      phase: "loading",
      suggestion: null,
      problem: null,
    }));
    this.updateTurn(id, (t) => ({
      ...t,
      phase:
        data.outcome === "answer"
          ? "answered"
          : data.outcome === "no_answer"
            ? "no-answer"
            : "failed",
      answer: data.answer,
      missing: data.missing,
      model: data.model,
      problem:
        data.outcome === "failed"
          ? { status: 200, rule: data.failure_code, detail: data.failure_code ?? "" }
          : null,
      suggestions,
    }));
    this.set({ busy: false });
    await Promise.all(suggestions.map((s) => this.loadSuggestion(id, s.id)));
  }

  private async loadSuggestion(turnId: number, suggestionId: string): Promise<void> {
    const result = await this.client.suggestion(suggestionId);
    this.updateSuggestion(
      turnId,
      suggestionId,
      result.ok
        ? { suggestion: result.data, phase: suggestionPhase(result.data) }
        : { phase: "error", problem: result.problem },
    );
  }

  /** Confirms a suggestion: the API performs the write as the person, or answers its refusal. */
  async confirm(
    turnId: number,
    suggestionId: string,
    reason: string,
    values?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.updateSuggestion(turnId, suggestionId, { phase: "confirming", problem: null });
    const result = await this.client.confirm(suggestionId, reason, values);
    if (result.ok) {
      this.updateSuggestion(turnId, suggestionId, {
        suggestion: result.data,
        phase: suggestionPhase(result.data),
      });
    } else {
      this.updateSuggestion(turnId, suggestionId, {
        phase: result.problem.status === 422 ? "refused" : "error",
        problem: result.problem,
      });
    }
  }

  async reject(turnId: number, suggestionId: string, reason: string): Promise<void> {
    this.updateSuggestion(turnId, suggestionId, { phase: "confirming", problem: null });
    const result = await this.client.reject(suggestionId, reason);
    this.updateSuggestion(
      turnId,
      suggestionId,
      result.ok
        ? { suggestion: result.data, phase: suggestionPhase(result.data) }
        : { phase: "error", problem: result.problem },
    );
  }

  /** Starts a new conversation. */
  clear(): void {
    this.set({ turns: [] });
  }
}

/** The Compass More menu entry for the assistant (AI notice: the Compass assistant). */
export const COMPASS_AURORA_ENTRY = {
  id: "aurora",
  /** Catalog key of the menu label, in the aurora namespace. */
  labelKey: "aurora.compass.menuLabel",
  descriptionKey: "aurora.compass.menuDescription",
  /** Lucide icon name. */
  icon: "Sparkles",
  /** Compass route of the assistant screen. */
  route: "/more/aurora",
  /** Shown only when the assistant feature is available to the person. */
  feature: "assistant",
} as const;
