/**
 * Tracing over the OpenTelemetry API (`@opentelemetry/api` 1.9.1, ADR 0001).
 *
 * The types below are the structural subset of the OpenTelemetry `Tracer` and `Span` this module
 * calls, so `trace.getTracer("atlas")` from the pinned API package is accepted as is, and this
 * module itself stays free of runtime dependencies (Supabase Edge Functions import it under Deno).
 * Without a tracer, `withSpan` still issues W3C ids so logs and error reports correlate.
 * Attributes are redacted before they reach the span.
 */

import { redactAttributes, redactString, type AttributeValue } from "./redact.ts";
import { newSpanId, newTraceId, type TraceContext } from "./trace-context.ts";

/** OpenTelemetry `SpanStatusCode`. */
export const SpanStatus = { UNSET: 0, OK: 1, ERROR: 2 } as const;
/** OpenTelemetry `SpanKind`. */
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 } as const;

export interface SpanContextLike {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

export interface SpanLike {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: { name: string; message: string; stack?: string }): unknown;
  end(): void;
  spanContext(): SpanContextLike;
}

export interface SpanOptionsLike {
  attributes?: Record<string, AttributeValue>;
  kind?: number;
}

export interface TracerLike {
  startActiveSpan<F extends (span: SpanLike) => unknown>(
    name: string,
    options: SpanOptionsLike,
    fn: F,
  ): ReturnType<F>;
}

/** A span that records nothing but carries real ids, used when no tracer is configured. */
export function detachedSpan(parent?: TraceContext | null): SpanLike {
  const context: SpanContextLike = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: parent?.spanId ?? newSpanId(),
    traceFlags: parent?.sampled === false ? 0 : 1,
  };
  return {
    setAttribute: () => undefined,
    setStatus: () => undefined,
    recordException: () => undefined,
    end: () => undefined,
    spanContext: () => context,
  };
}

export interface WithSpanOptions {
  readonly tracer?: TracerLike | undefined;
  readonly kind?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** Used for ids when no tracer is configured. */
  readonly parent?: TraceContext | null;
}

/**
 * Runs `fn` inside a span. A thrown error or rejected promise is recorded on the span, which ends
 * with status ERROR; the error is rethrown unchanged.
 */
export async function withSpan<T>(
  name: string,
  options: WithSpanOptions,
  fn: (span: SpanLike) => Promise<T> | T,
): Promise<T> {
  const attributes = redactAttributes(options.attributes ?? {});
  const run = async (span: SpanLike): Promise<T> => {
    try {
      const result = await fn(span);
      return result;
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  };
  if (!options.tracer) {
    const span = detachedSpan(options.parent);
    return run(span);
  }
  return options.tracer.startActiveSpan(
    name,
    { attributes, kind: options.kind ?? SpanKind.INTERNAL },
    (span) => run(span),
  ) as Promise<T>;
}

export function recordError(span: SpanLike, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException({
    name: err.name,
    message: redactString(err.message),
    ...(err.stack ? { stack: redactString(err.stack, 8192) } : {}),
  });
  span.setStatus({ code: SpanStatus.ERROR, message: redactString(err.message, 256) });
}

export function setSpanAttributes(
  span: SpanLike,
  attributes: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(redactAttributes(attributes)))
    span.setAttribute(key, value);
}
