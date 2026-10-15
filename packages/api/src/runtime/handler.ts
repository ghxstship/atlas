/**
 * The handler seam (ADR 0021, item 4). Each module's handlers live in
 * `src/handlers/<module>.ts` and export `handlers = defineHandlers("<Module>", { ... })`.
 * Keys are operationIds of that module; each handler receives the request validated by the
 * route's zod schemas and returns a response typed by the contract.
 */
import type { Module } from "../catalog/types.ts";
import type { ModuleOperations, Operations } from "../contract/operations.generated.ts";
import type { RequestContext } from "./context.ts";

export type OperationId = keyof Operations;

/** Validated request members of one operation. */
export interface HandlerRequest<Op extends OperationId> {
  readonly operationId: Op;
  readonly params: Operations[Op]["params"];
  readonly query: Operations[Op]["query"];
  readonly body: Operations[Op]["body"];
  /** `Idempotency-Key` on a POST, already checked for presence and length. */
  readonly idempotencyKey: string | undefined;
  /** `If-Match` on a PATCH, already checked for presence. */
  readonly ifMatch: string | undefined;
}

type Responses<Op extends OperationId> = Operations[Op]["responses"];

/** One success response the contract allows for the operation. */
export type HandlerResult<Op extends OperationId> = {
  [S in keyof Responses<Op>]: {
    readonly status: S;
    readonly body: Responses<Op>[S];
    readonly headers?: Readonly<Record<string, string>>;
  };
}[keyof Responses<Op>];

export type Handler<Op extends OperationId> = (
  request: HandlerRequest<Op>,
  context: RequestContext,
) => Promise<HandlerResult<Op>>;

/** The handlers of one module, keyed by operationId. Operations left out stay document-only. */
export type HandlerSet<M extends Module> = {
  readonly [Op in ModuleOperations[M]]?: Handler<Op>;
};

export interface ModuleHandlers<M extends Module> {
  readonly module: M;
  readonly handlers: HandlerSet<M>;
}

/** A module's handler set with the operation types erased, as the runtime mounts it. */
export interface AnyModuleHandlers {
  readonly module: Module;
  readonly handlers: Readonly<Record<string, ErasedHandler | undefined>>;
}

export interface ErasedRequest {
  readonly operationId: string;
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly ifMatch: string | undefined;
}

export interface ErasedResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type ErasedHandler = (
  request: ErasedRequest,
  context: RequestContext,
) => Promise<ErasedResult>;

/** Declares a module's handlers. The module name keys the allowed operationIds. */
export function defineHandlers<M extends Module>(
  module: M,
  handlers: HandlerSet<M>,
): ModuleHandlers<M> & AnyModuleHandlers {
  return { module, handlers } as ModuleHandlers<M> & AnyModuleHandlers;
}

/** 200 with a body. */
export function ok<B>(body: B, headers?: Readonly<Record<string, string>>) {
  return { status: 200 as const, body, ...(headers === undefined ? {} : { headers }) };
}

/** 201 with the created resource. */
export function created<B>(body: B, headers?: Readonly<Record<string, string>>) {
  return { status: 201 as const, body, ...(headers === undefined ? {} : { headers }) };
}

/** 202 for work accepted for processing. */
export function accepted<B>(body: B, headers?: Readonly<Record<string, string>>) {
  return { status: 202 as const, body, ...(headers === undefined ? {} : { headers }) };
}

/** 204 with no body, as a soft delete returns. */
export function noContent() {
  return { status: 204 as const, body: null };
}
