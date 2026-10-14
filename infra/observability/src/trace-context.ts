/**
 * W3C Trace Context (traceparent) parsing and generation. Atlas, Gateway, the public API and the
 * Edge Functions propagate one trace id per request, so a log line, a span and an error report for
 * the same request share it, with or without an OpenTelemetry exporter configured.
 */

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newTraceId(): string {
  let id = randomHex(16);
  while (id === ZERO_TRACE) id = randomHex(16);
  return id;
}

export function newSpanId(): string {
  let id = randomHex(8);
  while (id === ZERO_SPAN) id = randomHex(8);
  return id;
}

/** Parses a traceparent header. Returns null for a missing, malformed or all-zero value. */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === "ff" || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

/**
 * The context for work done on behalf of an incoming request: the caller's trace id when it sent
 * one, otherwise a new trace, always with a new span id for this hop.
 */
export function continueTrace(header: string | null | undefined, sampled = true): TraceContext {
  const parent = parseTraceparent(header);
  return {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    sampled: parent?.sampled ?? sampled,
  };
}

const REQUEST_ID = /^[A-Za-z0-9:._-]{8,128}$/;

/**
 * A request id for correlation: the platform's id when present and well formed (Vercel sends
 * `x-vercel-id`, Supabase sends `sb-request-id`), otherwise a new one.
 */
export function requestIdFrom(headers: Headers): string {
  for (const name of ["x-request-id", "x-vercel-id", "sb-request-id", "cf-ray"]) {
    const value = headers.get(name);
    if (value && REQUEST_ID.test(value)) return value;
  }
  return crypto.randomUUID();
}
