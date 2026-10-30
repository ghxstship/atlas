/**
 * `@ghxstship/xos-sdk`: the TypeScript SDK for the XOS public API.
 *
 * The runtime (transport, errors, pagination, webhooks) is hand-written; everything under
 * `generated/` is produced from `packages/api/openapi/v1.json` and never edited by hand.
 */
export { XosClient } from "./generated/client.ts";
export { API_TITLE, API_VERSION, OPERATIONS, RESOURCES, TAGS } from "./generated/operations.ts";
export type { OperationId, ResourceInfo } from "./generated/operations.ts";
export * from "./generated/resources.ts";
export type * from "./generated/schemas.ts";

export { Resource, XosClientCore } from "./runtime/client.ts";
export type { XosClientOptions } from "./runtime/client.ts";
export {
  XosApiError,
  XosAuthenticationError,
  XosBadRequestError,
  XosConflictError,
  XosError,
  XosNetworkError,
  XosNotFoundError,
  XosPreconditionFailedError,
  XosPreconditionRequiredError,
  XosRateLimitError,
  XosRefusalError,
  XosServerError,
  XosValidationError,
  errorForProblem,
  parseRetryAfter,
} from "./runtime/errors.ts";
export type { RefusalKind } from "./runtime/errors.ts";
export type { Problem as ProblemDetails } from "./runtime/errors.ts";
export { appendFilter, buildPath, buildQuery } from "./runtime/query.ts";
export { FILTER_OPERATORS } from "./runtime/types.ts";
export type {
  ApiResponse,
  Fields,
  FieldsParams,
  Filter,
  FilterOperator,
  FilterOperators,
  FilterValue,
  HttpMethod,
  ListAllParams,
  ListParams,
  MutationOptions,
  OperationSpec,
  Page,
  QueryInput,
  RateLimit,
  RequestInput,
  RequestOptions,
  SortKey,
  UpdateOptions,
} from "./runtime/types.ts";
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  parseSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./runtime/webhooks.ts";
export type { ParsedSignature, WebhookVerification } from "./runtime/webhooks.ts";
