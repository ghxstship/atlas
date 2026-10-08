# ADR 0003: API Conventions

- Status: Accepted (part of the Wave 1 contract freeze)
- Date: 2026-10-08
- Decider: Orchestrator (Wave 0)

## Context

Section 10.1 defines one public API for Atlas, Gateway, Compass, SDKs and third parties. A04 publishes OpenAPI v1 in Wave 1; this ADR fixes the conventions it must follow.

## Decision

### Contract

- Hono with `@hono/zod-openapi`, mounted at `/api/v1` in Atlas. Route definitions live in `packages/api`; schemas in `packages/schemas`.
- The OpenAPI 3.1 document is generated, served at `/api/v1/openapi.json` and never edited by hand.
- `operationId` is `{resource}.{verb}` in camelCase segments, for example `purchaseOrders.approve`. SDK method names derive from it.
- Every operation has a summary, a description and at least one example.

### Authentication

- Short-lived Supabase JWTs for Atlas, Gateway and Compass.
- Org-scoped API keys (hashed, capability-scoped, expiring) for servers: `Authorization: Bearer xos_live_...`.
- OAuth 2.1 with PKCE for user-delegated apps. Scopes map one to one to capability groups.

### Requests

- Cursor pagination: `limit` (default 50, maximum 200) and `cursor`. Responses carry `data` and `next_cursor` (null on the last page).
- Sparse fieldsets: `fields=id,title,record_state`.
- Filters: `filter[field][op]=value` with operators `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `is_null`, `contains`. Sort: `sort=field,-other`.
- `Idempotency-Key` is required on every POST. Keys are stored per tenant for 24 hours; a replay returns the original response.
- Updates use PATCH with `If-Match`. Responses carry `ETag`. A stale tag returns 412.

### Responses

- Errors use RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail` and `instance`.
- Refusals return 422 with `refusal` set to `NO_ANSWER`, `UNRATIFIED` or `REFUSE`, and a `reason`. A separation of duties refusal names the rule.
- A resource the caller may not see returns 404, never 403.
- Masked Restricted fields stay present with `{ "masked": true, "reason": "..." }`.
- NULL money is returned as `null`, never 0. Totals carry `unpriced_count`.
- Coded lists return in numeric code order.
- Rate limits use `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and 429 with `Retry-After`.

### Versioning

- Additive changes only within `/v1`. A breaking change ships as `/v2` with at least 12 months of overlap, and `Deprecation` and `Sunset` headers on `/v1`.
- CI runs oasdiff against the last released document (Section 18, gate 20).

### Webhooks

- Event names are `{resource}.{event}` from the domain event table, for example `record.state_changed`.
- Each delivery is signed with HMAC-SHA256 over `{timestamp}.{body}` in the header `XOS-Signature: t={unix},v1={hex}`, retried with exponential backoff for 72 hours, and replayable from Atlas.

## Alternatives considered

- GraphQL: rejected; Section 10.1 specifies versioned REST with OpenAPI.
- Offset pagination: rejected, because offsets drift under live inserts and cost more on large tenants.

## Consequences

Every UI mutation has an equivalent API operation (Section 5, rule 2). Contract tests exercise every operation against this ADR.
