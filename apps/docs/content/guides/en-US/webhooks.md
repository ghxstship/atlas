---
title: Webhooks
summary: Subscribe to events, verify the XOS-Signature header, handle retries and replay a delivery.
section: api
order: 6
---

Webhooks tell your system when something changes in XOS, so you do not have to poll.

## Subscribe

Create an endpoint in **Settings**, then **Webhooks**, or with `webhookEndpoints.create`. Give an HTTPS URL and the events to receive. List every event with `webhookEventTypes.list` or `xos webhooks events`. Event names are `{resource}.{event}`, for example `record.created`, `record.state_changed`, `project.gate_passed`, `po.approved`, `invoice.issued`, `timesheet.approved` and `incident.reported`.

Endpoints must resolve to a public address; XOS refuses to deliver to private networks.

## What a delivery looks like

Each delivery is a POST with a JSON body and these headers:

| Header          | Value                                            |
| --------------- | ------------------------------------------------ |
| `XOS-Signature` | `t={unix seconds},v1={hex}`                      |
| `XOS-Event`     | The event name                                   |
| `XOS-Delivery`  | The delivery identifier, the same on every retry |

Answer with any 2xx status within 10 seconds. Anything else is retried with exponential backoff for 72 hours. Use `XOS-Delivery` to ignore a delivery you already processed.

## Verify the signature

The signature is HMAC-SHA256 of `{timestamp}.{body}` under the endpoint's signing secret. Verify it on the raw body, before parsing, and reject timestamps older than five minutes to stop replays.

```ts
import { verifyWebhookSignature } from "@ghxstship/xos-sdk/webhooks";

const result = await verifyWebhookSignature({
  payload: rawBody,
  header: request.headers.get("XOS-Signature") ?? "",
  secret: process.env.XOS_WEBHOOK_SECRET,
});
if (!result.valid) return new Response(null, { status: 400 });
```

```python
from xos_sdk import verify_webhook_signature

result = verify_webhook_signature(raw_body, headers["XOS-Signature"], os.environ["XOS_WEBHOOK_SECRET"])
if not result.valid:
    abort(400)
```

During secret rotation the header can carry two `v1` signatures; accept the delivery if either matches.

## Test and replay

- `xos webhooks send --url URL --file body.json --secret-env XOS_WEBHOOK_SECRET` posts a signed test delivery to your endpoint.
- `xos webhooks verify --file body.json --signature "t=...,v1=..." --secret-env XOS_WEBHOOK_SECRET` checks a captured delivery.
- Replay any past delivery from Atlas, with `webhookDeliveries.replay`, or with `xos webhooks replay <delivery-id>`.
