---
title: Authentication
summary: API keys for servers, OAuth 2.1 with PKCE for apps that act for a person, and session tokens for the XOS apps.
section: start
order: 2
---

Every request carries one credential as a bearer token. The credential decides who is acting and in which organization; there is no organization header or path segment, and `org_id` is never accepted in a request body.

## API keys

Use an API key for a server or a script that acts on its own.

- A key belongs to one organization and acts as its own service account.
- Its scopes are capability groups, such as `projects` or `finance`. A request outside them is refused.
- Every key expires. Rotate it before it does with **Rotate** in Settings, or with `apiKeys.rotate`.
- Send it as `Authorization: Bearer xos_live_...`.

The API exchanges the key for a short-lived token for its service account on each request and caches it for a few minutes. Row-level security then applies to that service account exactly as it would to a member, so a key never sees more than its account may see.

> Keep keys on servers. Never ship one in a browser or a mobile app, and never commit one to source control.

## OAuth 2.1 with PKCE

Use OAuth when your app acts for a person who signs in. The flow is the authorization code flow with PKCE (S256), at `/oauth/authorize` and `/oauth/token`. Scopes map one to one to capability groups, and the person grants them for one organization.

## Session tokens

Atlas, Gateway and Compass call the API with short-lived Supabase session tokens. The organization is the one chosen in the context switcher.

## Check who you are

`GET /me` returns the person the credential acts as and the organization it is bound to:

```bash
curl "$XOS_BASE_URL/me" -H "Authorization: Bearer $XOS_API_KEY"
```

With the CLI, `xos auth status` shows the same, and `xos org list` shows one saved profile per organization. Switch with `xos org use <profile>`.

## When a credential fails

A missing, expired or revoked credential returns 401 with a problem body. A resource the credential may not see returns 404, never 403, so the API does not reveal that it exists. See [Errors and refusals](guide:errors).
