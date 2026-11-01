---
title: MCP server
summary: Connect Claude, ChatGPT or another AI agent to XOS through the hosted MCP endpoint, where every change is a proposal you confirm, or run @xos/mcp with one API key.
section: tools
order: 10
---

`@xos/mcp` is a Model Context Protocol server. It gives an AI agent tools over the public API. XOS hosts it for assistants such as Claude and ChatGPT, acting for the person who connected them, and you can also run it yourself, acting as one API key in one organization. The agent can never do more than the key allows: every tool call goes through the API, which applies the key's scopes, row-level security, field masking, separation of duties and refusals.

## Hosted endpoint for Claude and ChatGPT

The hosted endpoint is `https://api.ghxstship.tech/mcp` (or `/api/mcp` on your Atlas address when your XOS has no separate API host). It speaks Streamable HTTP, MCP revisions 2025-06-18 and 2025-03-26, without sessions: every request stands alone.

It accepts only an OAuth access token of an app registered in your organization. Dynamic client registration is off, so an Admin registers each assistant first:

1. In Settings, Integrations, AI assistant connectors, an Admin chooses Claude, ChatGPT or another MCP client, picks the capability groups it may reach by default, and registers it. Groups that reach Restricted data or the organization's control are never a default.
2. The panel shows the MCP server URL and the OAuth client ID. In Claude, open Settings, Connectors, Add custom connector, paste the URL, open Advanced settings and paste the client ID with no client secret. In ChatGPT, open Settings, Connectors, Create, paste the URL, choose OAuth and paste the client ID.
3. Each person who connects signs in to XOS and consents on the consent screen. Groups with Restricted data need a recent second factor.

The endpoint publishes its OAuth metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, with PKCE S256 only and no registration endpoint. A request without a valid token gets 401 with a `WWW-Authenticate` header naming that metadata.

### Changes are proposals

On the hosted endpoint, every write tool (`xos_create`, `xos_update`, `xos_action`, `xos_delete`) proposes the change instead of making it. Nothing changes until the person confirms it in Personal settings, Connected apps, one change at a time; the tool answers with the review link. Confirming runs the change with the person's own access, with the record's ETag, so a change proposed on stale data fails safely. A proposal expires after 7 days, and at once when the person stops letting the app act for them. The app itself can never confirm a proposal, and the database refuses any change it tries to make directly.

The data an assistant reads goes to that assistant's provider at your direction. If your organization limits API access by IP address, allow your AI provider's addresses too.

## Run it yourself

Add the server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "xos": {
      "command": "xos-mcp",
      "env": {
        "XOS_BASE_URL": "https://api.ghxstship.tech/v1",
        "XOS_API_KEY": "xos_live_..."
      }
    }
  }
}
```

The server speaks MCP revision 2025-06-18 over standard input and output.

> Create a dedicated key for each agent, with only the scopes it needs and a short expiry. Revoke it in Settings when the agent no longer needs access.

## Read tools

Always available:

| Tool                     | Does                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `xos_list_resources`     | Lists resources and their operations, optionally for one module      |
| `xos_describe_operation` | Shows an operation's parameters and its request and response schemas |
| `xos_whoami`             | Shows the person and organization the key acts as                    |
| `xos_list`               | Lists one page of a resource, with filters, sort and fields          |
| `xos_get`                | Reads one row and its ETag                                           |
| `xos_read`               | Calls any other read operation, such as `projects.gateReadiness`     |

## Write tools on your own server

Off by default. Turn them on for named resources or modules only:

```bash
xos-mcp --write purchaseOrders,Schedule
XOS_MCP_WRITE=all xos-mcp --allow-delete
```

| Tool         | Does                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `xos_create` | Creates a row; pass `idempotency_key` so a retried call never creates two |
| `xos_update` | Updates a row; needs `if_match` from `xos_get`                            |
| `xos_action` | Runs a POST action such as an approval or a transition                    |
| `xos_delete` | Moves a row to Trash; only with `--allow-delete`                          |

A write outside the scope fails with `outside_write_scope` and never reaches the API. Inside the scope, the API still decides: a key without the capability gets the API's own refusal.

## Errors the agent sees

API problems come back as tool results with `isError: true` and the full problem body, so the agent can read a refusal's `reason` and report it. Malformed tool arguments are JSON-RPC errors (-32602).
