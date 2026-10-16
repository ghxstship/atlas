/** Types shared by the hand-written runtime and the generated resources. */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Static description of one API operation, generated from the OpenAPI document. */
export interface OperationSpec {
  /** `{resource}.{verb}`, the OpenAPI `operationId`. */
  readonly id: string;
  readonly resource: string;
  readonly verb: string;
  readonly method: HttpMethod;
  /** Path template relative to the API base URL, for example `/projects/{id}`. */
  readonly path: string;
  readonly pathParams: readonly string[];
  /** Query parameters beyond `limit`, `cursor`, `fields`, `sort` and `filter`. */
  readonly queryParams: readonly string[];
  readonly requiredQueryParams: readonly string[];
  readonly paged: boolean;
  readonly fields: boolean;
  readonly idempotent: boolean;
  readonly ifMatch: boolean;
  readonly body: string | null;
  readonly bodyRequired: boolean;
  readonly successStatus: number;
  readonly response: string | null;
  readonly item: string | null;
  readonly tag: string;
  readonly summary: string;
  readonly capability: string | null;
  readonly scopes: readonly string[];
}

/** One filter value. Arrays are only meaningful for `in`. */
export type FilterValue = string | number | boolean;

/** Operators of the filter grammar `filter[field][op]=value` (ADR 0003). */
export interface FilterOperators {
  readonly eq?: FilterValue;
  readonly ne?: FilterValue;
  readonly lt?: FilterValue;
  readonly lte?: FilterValue;
  readonly gt?: FilterValue;
  readonly gte?: FilterValue;
  readonly in?: readonly FilterValue[] | string;
  readonly is_null?: boolean;
  readonly contains?: string;
}

export type FilterOperator = keyof FilterOperators;

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "contains",
];

type FieldOf<T> = Extract<keyof T, string>;

/** Conditions on top-level fields of `T`; conditions combine with AND. */
export type Filter<T> = { readonly [K in FieldOf<T>]?: FilterOperators };

/** A sort key: a field name, or the field name with a leading `-` for descending order. */
export type SortKey<T> = FieldOf<T> | `-${FieldOf<T>}`;

/** Sparse fieldset. `id` is always returned; the other members are the ones you name. */
export type Fields<T> = readonly FieldOf<T>[] | string;

export interface FieldsParams<T> {
  readonly fields?: Fields<T>;
}

export interface ListParams<T> extends FieldsParams<T> {
  /** Page size, 1 to 200. The server default is 50. */
  readonly limit?: number;
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
  readonly sort?: readonly SortKey<T>[] | string;
  readonly filter?: Filter<T>;
}

/** Parameters for `listAll`: the cursor is managed for you. */
export type ListAllParams<T> = Omit<ListParams<T>, "cursor">;

export type QueryScalar = string | number | boolean;

/** Wire-level query input accepted by the runtime. */
export interface QueryInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly fields?: readonly string[] | string;
  readonly sort?: readonly string[] | string;
  readonly filter?: Readonly<Record<string, FilterOperators>>;
  readonly [parameter: string]: unknown;
}

export interface RequestInput {
  readonly path?: Readonly<Record<string, string | number>>;
  /** A `QueryInput`; typed parameter objects such as `ListParams<T>` are accepted as they are. */
  readonly query?: object | undefined;
  readonly body?: unknown;
}

export interface RequestOptions {
  /** Cancels the request. */
  readonly signal?: AbortSignal;
  /** Extra headers for this request. Authentication headers are set by the client. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the client timeout for this request, in milliseconds. */
  readonly timeoutMs?: number;
}

export interface MutationOptions extends RequestOptions {
  /**
   * `Idempotency-Key` for a POST. The client generates one when omitted and reuses it on
   * every retry of the same call. Pass your own key to make a call safe to repeat across
   * process restarts: a replay returns the original response.
   */
  readonly idempotencyKey?: string;
}

export interface UpdateOptions extends RequestOptions {
  /** The `ETag` of the version you read. A stale tag fails with `XosPreconditionFailedError`. */
  readonly ifMatch: string;
}

export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly reset: number;
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly status: number;
  /** The `ETag` header, used as `ifMatch` on the next update. */
  readonly etag: string | null;
  readonly rateLimit: RateLimit | null;
  readonly headers: Headers;
}

export interface Page<T> extends ApiResponse<readonly T[]> {
  /** Cursor for the next page; null on the last page. */
  readonly nextCursor: string | null;
}
