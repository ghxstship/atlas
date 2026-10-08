/**
 * Shared OpenAPI components that implement ADR 0003: pagination, sparse fieldsets, the filter
 * grammar, Idempotency-Key, ETag and If-Match, RFC 9457 problem responses, rate limit headers
 * and the three security schemes.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { Problem, RefusalProblem, ValidationProblem } from "@xos/schemas";

export const PROBLEM_MEDIA_TYPE = "application/problem+json";

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/** Filter operators from ADR 0003. */
export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "contains",
] as const;

type Registry = OpenAPIHono["openAPIRegistry"];

export interface SharedParameters {
  readonly limit: z.ZodType;
  readonly cursor: z.ZodType;
  readonly fields: z.ZodType;
  readonly sort: z.ZodType;
  readonly filter: z.ZodType;
  readonly idempotencyKey: z.ZodType;
  readonly ifMatch: z.ZodType;
}

export function registerParameters(registry: Registry): SharedParameters {
  const limit = registry.registerParameter(
    "Limit",
    z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .meta({
        param: {
          name: "limit",
          in: "query",
          description: `Page size. Default ${DEFAULT_PAGE_SIZE}, maximum ${MAX_PAGE_SIZE}.`,
        },
        example: DEFAULT_PAGE_SIZE,
      }),
  );
  const cursor = registry.registerParameter(
    "Cursor",
    z
      .string()
      .min(1)
      .optional()
      .meta({
        param: {
          name: "cursor",
          in: "query",
          description: "Opaque cursor from `next_cursor` of the previous page.",
        },
        example: "eyJpZCI6IjAxOTJmMWUyIn0",
      }),
  );
  const fields = registry.registerParameter(
    "Fields",
    z
      .string()
      .regex(/^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*$/)
      .optional()
      .meta({
        param: {
          name: "fields",
          in: "query",
          description:
            "Sparse fieldset: a comma-separated list of top-level fields to return. `id` is always returned.",
        },
        example: "id,title,record_state",
      }),
  );
  const sort = registry.registerParameter(
    "Sort",
    z
      .string()
      .regex(/^-?[a-z_][a-z0-9_]*(,-?[a-z_][a-z0-9_]*)*$/)
      .optional()
      .meta({
        param: {
          name: "sort",
          in: "query",
          description:
            "Sort keys, comma-separated; a leading `-` sorts descending. Without `sort`, the documented default order applies (coded lists sort in numeric code order).",
        },
        example: "starts_at,-updated_at",
      }),
  );
  const filter = registry.registerParameter(
    "Filter",
    z
      .record(z.string(), z.record(z.enum(FILTER_OPERATORS), z.string()))
      .optional()
      .meta({
        param: {
          name: "filter",
          in: "query",
          style: "deepObject",
          explode: true,
          description:
            "Filter grammar `filter[field][op]=value`. Operators: eq, ne, lt, lte, gt, gte, in (comma-separated values), is_null (true or false) and contains. Conditions combine with AND.",
        },
        example: { record_state: { eq: "Blocked" } },
      }),
  );
  const idempotencyKey = registry.registerParameter(
    "IdempotencyKey",
    z
      .string()
      .min(8)
      .max(255)
      .meta({
        param: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "Required on every POST. Keys are stored per tenant for 24 hours; a replay with the same key returns the original response.",
        },
        example: "8f14e45f-ceea-467f-a0e6-1d2c3b4a5968",
      }),
  );
  const ifMatch = registry.registerParameter(
    "IfMatch",
    z
      .string()
      .min(1)
      .meta({
        param: {
          name: "If-Match",
          in: "header",
          required: true,
          description:
            "The `ETag` of the version being updated. A stale tag returns 412; a missing tag returns 428.",
        },
        example: '"W/1a2b3c4d"',
      }),
  );
  return { limit, cursor, fields, sort, filter, idempotencyKey, ifMatch };
}

/** Response headers, registered once and referenced from every response. */
const RESPONSE_HEADERS = {
  ETag: {
    description: "Entity tag of the returned version; send it as `If-Match` to update.",
    schema: { type: "string", example: '"W/1a2b3c4d"' },
  },
  "RateLimit-Limit": {
    description: "Requests allowed in the current window.",
    schema: { type: "integer", example: 600 },
  },
  "RateLimit-Remaining": {
    description: "Requests left in the current window.",
    schema: { type: "integer", example: 598 },
  },
  "RateLimit-Reset": {
    description: "Seconds until the window resets.",
    schema: { type: "integer", example: 42 },
  },
  "Retry-After": {
    description: "Seconds to wait before retrying.",
    schema: { type: "integer", example: 30 },
  },
} as const;

type HeaderName = keyof typeof RESPONSE_HEADERS;

const headerRef = (name: HeaderName) => ({ $ref: `#/components/headers/${name}` });

export function registerHeaders(registry: Registry): void {
  for (const [name, header] of Object.entries(RESPONSE_HEADERS)) {
    registry.registerComponent("headers", name, header);
  }
}

export const ProblemResponseNames = {
  400: "BadRequest",
  401: "Unauthorized",
  404: "NotFound",
  409: "Conflict",
  412: "PreconditionFailed",
  422: "Unprocessable",
  428: "PreconditionRequired",
  429: "TooManyRequests",
} as const;

export type ProblemStatus = keyof typeof ProblemResponseNames;

function problemExample(status: number, title: string, detail: string, slug: string) {
  return { type: `/problems/${slug}`, title, status, detail };
}

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

export function registerProblemResponses(registry: Registry): void {
  registry.register("Problem", Problem);
  registry.register("RefusalProblem", RefusalProblem);
  registry.register("ValidationProblem", ValidationProblem);
  const problem = (
    status: ProblemStatus,
    description: string,
    slug: string,
    title: string,
    detail: string,
  ) => {
    registry.registerComponent("responses", ProblemResponseNames[status], {
      description,
      content: {
        [PROBLEM_MEDIA_TYPE]: {
          schema: ref("Problem"),
          example: problemExample(status, title, detail, slug),
        },
      },
    });
  };
  problem(
    400,
    "The request is malformed.",
    "bad-request",
    "Bad Request",
    "The cursor is not valid for this list.",
  );
  problem(
    401,
    "No valid credential was presented.",
    "unauthorized",
    "Unauthorized",
    "The access token has expired.",
  );
  problem(
    404,
    "The resource does not exist or the caller may not see it. A hidden resource is always 404, never 403.",
    "not-found",
    "Not Found",
    "No resource with this identifier is visible to you.",
  );
  problem(
    409,
    "The request conflicts with the current state, such as an Idempotency-Key reused with a different body.",
    "conflict",
    "Conflict",
    "This Idempotency-Key was used with a different request body.",
  );
  problem(
    412,
    "The If-Match tag is stale: the resource changed since it was read.",
    "precondition-failed",
    "Precondition Failed",
    "The resource changed since you read it. Fetch it again and retry.",
  );
  problem(
    428,
    "If-Match is required on updates.",
    "precondition-required",
    "Precondition Required",
    "Send the ETag you read as If-Match.",
  );

  registry.registerComponent("responses", ProblemResponseNames[422], {
    description:
      "The request failed validation, or a rule refused it. A refusal carries `refusal` (NO_ANSWER, UNRATIFIED or REFUSE) and a `reason`; a separation of duties refusal names the rule.",
    content: {
      [PROBLEM_MEDIA_TYPE]: {
        schema: { oneOf: [ref("RefusalProblem"), ref("ValidationProblem")] },
        examples: {
          refusal: {
            summary: "Separation of duties refusal",
            value: {
              ...problemExample(422, "Refused", "The request was refused by a rule.", "refused"),
              refusal: "REFUSE",
              reason: "The creator of a purchase order cannot approve it.",
              rule: "sod.po.creator_cannot_approve",
            },
          },
          validation: {
            summary: "Validation failure",
            value: {
              ...problemExample(
                422,
                "Unprocessable Content",
                "One field is invalid.",
                "validation",
              ),
              errors: [{ pointer: "/title", detail: "Required." }],
            },
          },
        },
      },
    },
  });

  registry.registerComponent("responses", ProblemResponseNames[429], {
    description: "Rate limit exceeded. Retry after the number of seconds in `Retry-After`.",
    headers: { "Retry-After": headerRef("Retry-After") },
    content: {
      [PROBLEM_MEDIA_TYPE]: {
        schema: ref("Problem"),
        example: problemExample(429, "Too Many Requests", "Retry in 30 seconds.", "rate-limited"),
      },
    },
  });
}

export function successHeaders(withETag: boolean) {
  const names: HeaderName[] = withETag
    ? ["ETag", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]
    : ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"];
  return Object.fromEntries(names.map((n) => [n, headerRef(n)]));
}

/** Security schemes (ADR 0003, Section 10.1). */
export const SECURITY_SCHEMES = {
  bearerJwt: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "Short-lived Supabase session JWT for Atlas, Gateway and Compass. The active organization is the one chosen in the context switcher.",
  },
  apiKey: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "xos_live API key",
    description:
      "Org-scoped API key for servers, sent as `Authorization: Bearer xos_live_...`. Keys are hashed, capability-scoped and expiring.",
  },
  oauth2: {
    type: "oauth2",
    description:
      "OAuth 2.1 authorization code flow with PKCE (S256) for user-delegated apps. Scopes map one to one to capability groups in `packages/schemas/capabilities.yaml`.",
    flows: {
      authorizationCode: {
        authorizationUrl: "/oauth/authorize",
        tokenUrl: "/oauth/token",
        refreshUrl: "/oauth/token",
        scopes: {},
      },
    },
  },
} as const;

export const SECURITY_REQUIREMENT = [{ bearerJwt: [] }, { apiKey: [] }, { oauth2: [] }];

export function registerSecuritySchemes(registry: Registry): void {
  for (const [name, scheme] of Object.entries(SECURITY_SCHEMES)) {
    registry.registerComponent("securitySchemes", name, scheme);
  }
}
