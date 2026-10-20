---
title: Quickstart
summary: Create an API key, make your first request, and read the response, in curl, TypeScript, Python and the xos CLI.
section: start
order: 1
---

The XOS public API is one versioned REST API. On the hosted service its base URL is `https://api.ghxstship.tech/v1`; a self-hosted deployment serves it at `/api/v1` on its Atlas origin. Atlas, Gateway and Compass use it, and so can your integrations. This guide takes you from no key to your first list of projects.

## Create an API key

1. In Atlas, open **Settings**, then **API keys**. You need the `org.api_keys.manage` capability.
2. Choose **Create key**, name it after the integration, pick the scopes it needs, and set an expiry.
3. Copy the key. It starts with `xos_live_` and is shown once; Atlas stores only its hash.

An API key belongs to one organization and acts as its own service account. It can do what its scopes allow and nothing more. See [Authentication](guide:authentication) for scopes and session tokens.

## Make your first request

Set two variables, then list the projects the key can see:

```bash
export XOS_BASE_URL="https://api.ghxstship.tech/v1"
export XOS_API_KEY="xos_live_..."

curl "$XOS_BASE_URL/projects?limit=5" \
  -H "Authorization: Bearer $XOS_API_KEY"
```

The response is one page of rows and a cursor to the next page:

```json
{
  "data": [{ "id": "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", "name": "Harborfront Summer Series" }],
  "next_cursor": null
}
```

## Use an SDK or the CLI

The SDKs and the CLI are generated from the same OpenAPI document as this reference, so every operation is available in each.

```ts
import { XosClient } from "@xos/sdk";

const xos = new XosClient({ baseUrl: process.env.XOS_BASE_URL, apiKey: process.env.XOS_API_KEY });
const page = await xos.projects.list({ limit: 5 });
console.log(page.data.map((p) => p.name));
```

```python
import os
from xos_sdk import XosClient

xos = XosClient(os.environ["XOS_BASE_URL"], api_key=os.environ["XOS_API_KEY"])
for project in xos.projects.list_all(limit=50):
    print(project["name"])
```

```bash
xos auth login --base-url "$XOS_BASE_URL"   # reads the key from XOS_API_KEY
xos projects list --limit 5
```

## Next steps

- Page, filter and sort lists: [Pagination and filters](guide:pagination-and-filters).
- Create and update safely: [Writes, idempotency and concurrency](guide:writes).
- Handle every error shape: [Errors and refusals](guide:errors).
- Look up any operation in the [API reference](reference:projects).
