import type { ModelConfig } from "./config.ts";
import type { AiFeature, ModelClient, ModelUsage } from "./model.ts";
import { redactText } from "./redact.ts";

/**
 * One Aurora request from authorization to log (Section 4.7, ADR 0020).
 *
 * 1. `store.begin` calls `app.ai_begin_request` with the person's own session: membership, the
 *    aurora_ai plan feature, the Admin switch and the monthly allowance are all checked there.
 * 2. The feature runs against the model.
 * 3. `store.complete` logs the outcome with the prompt and output redacted, and the token counts.
 * 4. Proposed changes are stored with `store.propose`, pending the person's confirmation.
 *
 * A refusal at step 1 is returned, never thrown. A model failure is logged as Failed with a code
 * and returned as `failed`, so no error path is silent.
 */

export type StoreResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error:
        | { readonly kind: "refusal"; readonly rule: string; readonly message: string }
        | { readonly kind: "not-found" }
        | { readonly kind: "conflict" | "invalid" | "unexpected"; readonly message: string };
    };

export interface ProposedField {
  readonly field_path: string;
  readonly value?: unknown;
  readonly confidence?: number;
  readonly refusal?: "NO_ANSWER";
  readonly missing?: string;
  readonly source_excerpt?: string;
}

export interface ProposedChange {
  /** Public API operation that performs the change, for example `savedViews.create`. */
  readonly operationId: string;
  readonly targetId: string | null;
  /** What will change, shown on the confirmation step. */
  readonly summary: string;
  readonly fields: readonly ProposedField[];
}

export interface Subject {
  readonly table: string;
  readonly id: string;
}

/** The persistence the runner needs. `@xos/data` implements it over the 0650 RPCs. */
export interface AuroraStore {
  begin(
    orgId: string,
    feature: AiFeature,
    model: string,
    subject: Subject | null,
  ): Promise<StoreResult<string>>;
  complete(input: {
    readonly requestId: string;
    readonly outcome: "Answered" | "No Answer" | "Failed";
    readonly prompt: string;
    readonly output: string | null;
    readonly usage: ModelUsage | null;
    readonly failureCode: string | null;
  }): Promise<StoreResult<null>>;
  propose(requestId: string, change: ProposedChange): Promise<StoreResult<string>>;
}

export interface AuroraContext {
  readonly orgId: string;
  readonly client: ModelClient;
  readonly store: AuroraStore;
  readonly config: ModelConfig;
  /** Today's date in the org's time zone, ISO 8601, so relative dates resolve without guessing. */
  readonly today: string;
}

/** What a feature hands back to the runner after talking to the model. */
export type FeatureOutput<T> =
  | {
      readonly kind: "answer";
      readonly value: T;
      readonly prompt: string;
      readonly output: string;
      readonly usage: ModelUsage;
      readonly proposals?: readonly ProposedChange[];
    }
  | {
      readonly kind: "no-answer";
      /** What the data lacks, in a sentence the person can act on. */
      readonly missing: string;
      readonly prompt: string;
      readonly output: string;
      readonly usage: ModelUsage;
    };

export interface StoredProposal extends ProposedChange {
  readonly suggestionId: string;
}

/** Every result carries `aiGenerated: true` so each surface shows the EU AI Act label. */
export type AuroraResult<T> =
  | {
      readonly kind: "answer";
      readonly aiGenerated: true;
      readonly requestId: string;
      readonly model: string;
      readonly value: T;
      readonly proposals: readonly StoredProposal[];
    }
  | {
      readonly kind: "no-answer";
      readonly aiGenerated: true;
      /** Null when no model was called because there was nothing to send. */
      readonly requestId: string | null;
      readonly model: string | null;
      readonly missing: string;
    }
  | { readonly kind: "refused"; readonly rule: string; readonly message: string }
  | {
      readonly kind: "failed";
      readonly requestId: string | null;
      readonly code: string;
      readonly message: string;
    };

/** Failure codes stored in `ai_requests.failure_code`. */
export type FailureCode =
  "model_error" | "model_output_invalid" | "proposal_refused" | "log_failed";

export class FeatureError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "FeatureError";
  }
}

/** A result for a request that needs no model call (for example nothing to summarize). */
export function localNoAnswer(missing: string): AuroraResult<never> {
  return { kind: "no-answer", aiGenerated: true, requestId: null, model: null, missing };
}

export async function runFeature<T>(
  ctx: AuroraContext,
  feature: AiFeature,
  subject: Subject | null,
  execute: (model: string, maxTokens: number) => Promise<FeatureOutput<T>>,
): Promise<AuroraResult<T>> {
  const model = ctx.config.modelFor(feature);
  const begun = await ctx.store.begin(ctx.orgId, feature, model, subject);
  if (!begun.ok) {
    if (begun.error.kind === "refusal") {
      return { kind: "refused", rule: begun.error.rule, message: begun.error.message };
    }
    if (begun.error.kind === "not-found") {
      return {
        kind: "refused",
        rule: "not_a_member",
        message: "You are not a member of this org.",
      };
    }
    return { kind: "failed", requestId: null, code: "log_failed", message: begun.error.message };
  }
  const requestId = begun.data;

  let output: FeatureOutput<T>;
  try {
    output = await execute(model, ctx.config.maxTokensFor(feature));
  } catch (error) {
    const code: FailureCode = error instanceof FeatureError ? error.code : "model_error";
    const message = error instanceof Error ? error.message : String(error);
    const logged = await ctx.store.complete({
      requestId,
      outcome: "Failed",
      prompt: "",
      output: null,
      usage: null,
      failureCode: code,
    });
    return {
      kind: "failed",
      requestId,
      code: logged.ok ? code : "log_failed",
      message,
    };
  }

  const completed = await ctx.store.complete({
    requestId,
    outcome: output.kind === "answer" ? "Answered" : "No Answer",
    prompt: redactText(output.prompt),
    output: redactText(output.output),
    usage: output.usage,
    failureCode: null,
  });
  if (!completed.ok) {
    return {
      kind: "failed",
      requestId,
      code: "log_failed",
      message: "message" in completed.error ? completed.error.message : "The request log failed.",
    };
  }

  if (output.kind === "no-answer") {
    return { kind: "no-answer", aiGenerated: true, requestId, model, missing: output.missing };
  }

  const proposals: StoredProposal[] = [];
  for (const change of output.proposals ?? []) {
    const stored = await ctx.store.propose(requestId, change);
    if (!stored.ok) {
      return {
        kind: "failed",
        requestId,
        code: "proposal_refused",
        message:
          stored.error.kind === "not-found"
            ? "The suggestion could not be stored."
            : stored.error.message,
      };
    }
    proposals.push({ ...change, suggestionId: stored.data });
  }
  return { kind: "answer", aiGenerated: true, requestId, model, value: output.value, proposals };
}
