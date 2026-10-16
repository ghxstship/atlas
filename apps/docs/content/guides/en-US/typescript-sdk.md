---
title: TypeScript SDK
summary: The @xos/sdk client, generated from the OpenAPI document, with typed models, pagination, filters, idempotency, ETags and problem errors.
section: tools
order: 7
---

`@xos/sdk` covers every operation in the OpenAPI document. Its models, method signatures and operation table are generated from the document by CI and never edited by hand, so a new operation appears in the SDK as soon as it appears in the API. It runs on Node.js 22 or later, in browsers and on edge runtimes, with no dependencies.

## Create a client

```ts
import { XosClient } from "@xos/sdk";

const xos = new XosClient({
  baseUrl: "https://atlas.example.com/api/v1",
  apiKey: process.env.XOS_API_KEY,
});
```

Instead of `apiKey`, pass `accessToken` for an OAuth or session token, or `getToken` to supply a fresh token before every request. Other options: `maxRetries` (default 2), `timeoutMs` (default 30000) and a custom `fetch`.

## Call operations

Each resource is a property and each operation a method named after its operation id: `projects.list` is `xos.projects.list()`, `purchaseOrders.approve` is `xos.purchaseOrders.approve(id, body)`.

```ts
const { data: project, etag } = await xos.projects.get(projectId, {
  fields: ["name", "project_state"],
});

await xos.projects.update(projectId, { name: "Harborfront Fall Series" }, { ifMatch: etag! });

await xos.records.transition(recordId, {
  expected_state: "Scheduled",
  to_state: "Blocked",
  blocker_text: "Waiting on the rigging plot.",
});
```

Every result has `data`, `status`, `etag`, `rateLimit` and `headers`. Path parameters come first, then the body, then query parameters, then options.

## Lists

`list()` returns one page with `data` and `nextCursor`. `listAll()` iterates every row across pages. Filters and sorting are typed against the row:

```ts
for await (const po of xos.purchaseOrders.listAll({
  filter: { po_state: { eq: "Approved" } },
  sort: ["-created_at"],
  fields: ["id", "po_number", "currency_code"],
})) {
  console.log(po.po_number);
}
```

## Writes

POST methods send an `Idempotency-Key` automatically and reuse it on retries. Pass `idempotencyKey` to make a call safe across restarts. Updates require `ifMatch`; the type system will not let you omit it.

## Errors

```ts
import { XosPreconditionFailedError, XosRefusalError, XosValidationError } from "@xos/sdk";

try {
  await xos.purchaseOrders.approve(poId, {});
} catch (error) {
  if (error instanceof XosRefusalError) console.log(error.refusal, error.reason, error.rule);
  else if (error instanceof XosValidationError) console.log(error.errors);
  else if (error instanceof XosPreconditionFailedError) console.log("Read again and retry");
  else throw error;
}
```

See [Errors and refusals](guide:errors) for every class.

## Webhooks

`verifyWebhookSignature` and `signWebhookPayload` are exported from `@xos/sdk/webhooks`. See [Webhooks](guide:webhooks).

## Calling an operation by id

`xos.request(OPERATIONS["projects.get"], { path: { id } })` calls any operation from the generated table. The CLI and the MCP server are built this way.
