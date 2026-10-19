# @xos/sdk

The TypeScript SDK for the XOS public API. Models, method signatures and the operation table are generated from the OpenAPI v1 document, so every operation in the API reference is a typed method. It runs on Node.js 22.12 or later, in browsers and on edge runtimes, and has no dependencies.

```sh
npm install @xos/sdk
```

## Use

```ts
import { XosClient } from "@xos/sdk";

const xos = new XosClient({
  baseUrl: "https://atlas.example.com/api/v1",
  apiKey: process.env.XOS_API_KEY,
});

const { data: project, etag } = await xos.projects.get(projectId);
await xos.projects.update(projectId, { name: "Harborfront Fall Series" }, { ifMatch: etag! });

for await (const po of xos.purchaseOrders.listAll({ filter: { po_state: { eq: "Approved" } } })) {
  console.log(po.po_number);
}
```

- POST methods send an `Idempotency-Key` and reuse it on retries.
- Updates require `ifMatch`; a stale ETag fails with `XosPreconditionFailedError`.
- Problem responses are raised as typed `XosApiError` subclasses, such as `XosValidationError` and `XosNotFoundError`.
- Rate limits and `Retry-After` are honored, with `maxRetries` (default 2) and `timeoutMs` (default 30000).

Verify webhook signatures with the `@xos/sdk/webhooks` entry point:

```ts
import { verifyWebhookSignature } from "@xos/sdk/webhooks";

const result = await verifyWebhookSignature({
  payload: rawBody, // the body exactly as received
  header: request.headers.get("XOS-Signature") ?? "",
  secret: process.env.XOS_WEBHOOK_SECRET!,
});
```

## Documentation

- Guide: [TypeScript SDK](https://github.com/ghxstship/atlas/blob/main/apps/docs/content/guides/en-US/typescript-sdk.md)
- API reference: the docs site, generated from [`packages/api/openapi/v1.json`](https://github.com/ghxstship/atlas/blob/main/packages/api/openapi/v1.json)

## Versioning

The package version follows the XOS release (`v4.0.0` publishes `4.0.0`). Within `/v1` the API changes only additively, so a newer SDK keeps working against an older server for every operation both know.

## License

MIT. See [LICENSE](LICENSE). The XOS platform itself is AGPL-3.0-only.
