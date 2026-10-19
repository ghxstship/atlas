# xos-sdk

The Python SDK for the XOS public API. Models, methods and the operation table are generated from the OpenAPI v1 document, so every operation in the API reference is a method. It uses only the standard library and runs on Python 3.9 or later.

```sh
pip install xos-sdk
```

## Use

```python
import os
from xos_sdk import XosClient

xos = XosClient("https://atlas.example.com/api/v1", api_key=os.environ["XOS_API_KEY"])

response = xos.projects.get(project_id)
xos.projects.update(project_id, {"name": "Harborfront Fall Series"}, if_match=response.etag)

for po in xos.purchase_orders.list_all(filter={"po_state": {"eq": "Approved"}}):
    print(po["po_number"])
```

- Resources are snake_case attributes; `purchaseOrders.approve` is `xos.purchase_orders.approve(po_id, body)`.
- POST methods send an `Idempotency-Key` and reuse it on retries; updates take `if_match`.
- Rows are plain dictionaries typed as `TypedDict` models, and the package ships `py.typed`.

## Documentation

Guide: [Python SDK](https://github.com/ghxstship/atlas/blob/main/apps/docs/content/guides/en-US/python-sdk.md).

## Versioning

The package version follows the XOS release (`v4.0.0` publishes `4.0.0`). Within `/v1` the API changes only additively.

## License

MIT. See [LICENSE](LICENSE). The XOS platform itself is AGPL-3.0-only.
