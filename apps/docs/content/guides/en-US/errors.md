---
title: Errors and refusals
summary: RFC 9457 problem details, validation pointers, refusals and their reasons, masked fields and rate limits.
section: api
order: 5
---

Every error is an `application/problem+json` body with `type`, `title`, `status`, `detail` and `instance`. The `type` is a stable URI such as `/problems/not-found`; match on it, not on `title`.

## Statuses

| Status | Meaning                                                                            | What to do                           |
| ------ | ---------------------------------------------------------------------------------- | ------------------------------------ |
| 400    | Malformed request, such as an unknown query parameter or a missing Idempotency-Key | Fix the request                      |
| 401    | Missing, expired or revoked credential                                             | Renew the credential                 |
| 404    | The resource does not exist, or you may not see it                                 | Check the identifier and your access |
| 409    | Conflict, such as an idempotency key reused with another body                      | Use a new key for a new action       |
| 412    | `If-Match` is stale                                                                | Read again and retry                 |
| 422    | Validation failed, or a rule refused the request                                   | Read `errors` or `refusal`           |
| 428    | `If-Match` is missing                                                              | Send the ETag you read               |
| 429    | Rate limited                                                                       | Wait for `Retry-After`               |

## Validation errors

A 422 with `errors` lists one JSON Pointer per invalid member:

```json
{
  "type": "/problems/validation",
  "title": "Unprocessable Content",
  "status": 422,
  "errors": [{ "pointer": "/currency", "detail": "must match ^[A-Z]{3}$" }]
}
```

## Refusals

A 422 with `refusal` means XOS declined to answer or act, and `reason` says why:

| Refusal      | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `NO_ANSWER`  | The data needed to answer does not exist yet. XOS will not guess.                                           |
| `UNRATIFIED` | The value exists but has not been ratified, so it cannot be relied on.                                      |
| `REFUSE`     | A rule forbids the action, such as a disallowed transition or a separation of duties rule. `rule` names it. |

A refusal is an answer, not a fault. Show the reason to the person and never retry it unchanged.

## Masked fields

A restricted field you may not read stays in the response as `{ "masked": true, "reason": "..." }`, so the shape of the row never changes with your access.

## Rate limits

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A 429 carries `Retry-After` in seconds. The SDKs wait and retry 429, 502, 503 and 504 for you, twice by default, reusing the same Idempotency-Key.

## In the SDKs

Each status raises its own error class: `XosValidationError`, `XosRefusalError` (with `refusal`, `reason` and `rule`), `XosPreconditionFailedError`, `XosNotFoundError`, `XosRateLimitError` and so on, all subclasses of `XosApiError` carrying the full `problem`. Transport failures raise `XosNetworkError`.
