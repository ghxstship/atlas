---
title: Python SDK
summary: The xos-sdk package for Python 3.9 and later, generated from the OpenAPI document, with no dependencies beyond the standard library.
section: tools
order: 8
---

`xos-sdk` covers every operation in the OpenAPI document. Its models, methods and operation table are generated from the document by CI and never edited by hand. It uses only the Python standard library, so it installs anywhere Python 3.9 or later runs.

## Create a client

```python
import os
from xos_sdk import XosClient

xos = XosClient("https://api.ghxstship.tech/v1", api_key=os.environ["XOS_API_KEY"])
```

Instead of `api_key`, pass `access_token` for a session token, or `get_token` to supply a fresh token before every request. Other options: `max_retries` (default 2) and `timeout` in seconds (default 30).

## Call operations

Resources are attributes in snake_case and operations are methods: `purchaseOrders.approve` is `xos.purchase_orders.approve(po_id, body)`.

```python
response = xos.projects.get(project_id, fields=["name", "project_state"])
project, etag = response.data, response.etag

xos.projects.update(project_id, {"name": "Harborfront Fall Series"}, if_match=etag)
```

Path parameters are positional, then the body; query parameters, `if_match`, `idempotency_key` and `options` are keyword-only. Rows are plain dictionaries typed as `TypedDict` models, so editors and type checkers know their fields.

## Lists

`list()` returns a `Page` with `data` and `next_cursor`. `list_all()` yields every row across pages:

```python
for po in xos.purchase_orders.list_all(filter={"po_state": {"eq": "Approved"}}, sort=["-created_at"]):
    print(po["po_number"])
```

## Writes

POST methods send an `Idempotency-Key` automatically and reuse it across retries. Pass `idempotency_key=` to make a call safe across restarts. Updates require `if_match`.

## Errors

```python
from xos_sdk import XosRefusalError, XosValidationError

try:
    xos.purchase_orders.approve(po_id, {})
except XosRefusalError as refused:
    print(refused.refusal, refused.reason, refused.rule)
except XosValidationError as invalid:
    print(invalid.errors)
```

Every error class carries `status`, `problem` and `headers`. Transport failures raise `XosNetworkError`.

## Webhooks

`verify_webhook_signature` and `sign_webhook_payload` are exported from `xos_sdk`. See [Webhooks](guide:webhooks).
