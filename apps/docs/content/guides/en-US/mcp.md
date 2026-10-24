---
title: MCP server
summary: Let AI agents read and, when you allow it, change XOS through @xos/mcp, with exactly the permissions of one API key.
section: tools
order: 10
---

`@xos/mcp` is a Model Context Protocol server. It gives an AI agent tools over the public API, acting as one API key in one organization. The agent can never do more than the key allows: every tool call goes through the API, which applies the key's scopes, row-level security, field masking, separation of duties and refusals.

## Run it

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

## Write tools

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
