---
title: Writes, idempotency and concurrency
summary: Create with an Idempotency-Key, update with If-Match, move lifecycles with compare-and-set transitions, and delete to Trash.
section: api
order: 4
---

Every change in the apps has an equivalent API operation, and every write follows the same rules, so a retried or concurrent request never corrupts data.

## Idempotency keys

Every POST requires an `Idempotency-Key` header of 8 to 255 characters. The API stores each key per organization for 24 hours:

- A replay with the same key and the same body returns the original response, with `Idempotent-Replayed: true`.
- The same key with a different body returns 409.

Generate one key per intended action and reuse it on every retry of that action. The SDKs generate a key for each call and reuse it across their own retries. Pass your own key when a retry may come from a new process, for example an import job that restarts:

```ts
await xos.projects.create(body, { idempotencyKey: `import-${fileHash}-${rowNumber}` });
```

`xos import` derives a key from the file and the row, so rerunning an import never creates a row twice.

## ETags and If-Match

Reads return an `ETag`. An update (PATCH) must send it back as `If-Match`:

- A current tag applies the update and returns the new `ETag`.
- A stale tag returns 412: someone changed the row since you read it. Read it again, reapply your change, and retry.
- A missing tag returns 428.

```python
current = xos.projects.get(project_id)
xos.projects.update(project_id, {"name": "Harborfront Fall Series"}, if_match=current.etag)
```

PATCH changes only the fields you send. Omitted fields stay as they are.

## Lifecycle transitions

States never change through PATCH. Each lifecycle moves through `POST /{collection}/{id}/transitions` with the state you believe the row is in and the state you want:

```json
{
  "expected_state": "Proposed",
  "to_state": "Active",
  "reason": "Client approved the revised scope."
}
```

If the row is no longer in `expected_state`, or the move is not allowed, the API refuses with 422 and says why. Each transition is written to the row's transition ledger.

## Deletes

DELETE moves a row to Trash, where it can be restored for its table's retention period.

## Money

Money is integer minor units with a currency: `1250` with `USD` is $12.50. `null` means unpriced, never zero, and totals carry `unpriced_count` so you can tell a real zero from missing prices.
