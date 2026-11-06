# @xos/mcp

The XOS Model Context Protocol server: tools over the XOS public API for AI agents.

- **stdio** (`xos-mcp`): acts as one API key in one organization. Read tools always; write tools only for the
  resources or modules named with `--write`, and deletes only with `--allow-delete`. Configure it with
  `XOS_BASE_URL` and `XOS_API_KEY`.
- **Hosted** (`@xos/mcp/http`, served by Atlas at `/api/mcp` and by the API host at `/mcp`): stateless Streamable
  HTTP, MCP 2025-06-18 and 2025-03-26, for Claude, ChatGPT and other MCP clients connected as OAuth apps of the
  organization (ADR 0155 D1). It takes only an OAuth access token, never an API key. Every write tool records a
  proposal the person confirms in XOS, Personal settings, Connected apps; nothing changes until they do, and a
  proposal expires after 7 days (ADR 0155 D2).

## Modules

| Module            | Does                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `src/protocol.ts` | JSON-RPC 2.0 and the MCP lifecycle; stateful on stdio, stateless over HTTP                |
| `src/tools.ts`    | The tools; in hosted mode write tools propose through the `propose` the caller passes     |
| `src/server.ts`   | `createSession` (an API key) and `createHostedSession` (an access token and proposals)    |
| `src/stdio.ts`    | Newline-delimited JSON-RPC on stdin and stdout                                            |
| `src/http.ts`     | `handleMcpHttp`: POST only, JSON only, one message, the Origin allow-list and the version |

The hosted transport keeps no session: there is no `Mcp-Session-Id`, GET and DELETE answer 405, a notification
answers 202. The caller authenticates the request before handing it to `handleMcpHttp` and builds the session for
the negotiated revision. Tool and server strings are en-US only (ADR 0024 decision 4).

## Tests

`pnpm --filter @xos/mcp test` runs the protocol, the tools against the SDK's contract server (stdio and hosted
modes) and the HTTP transport.
