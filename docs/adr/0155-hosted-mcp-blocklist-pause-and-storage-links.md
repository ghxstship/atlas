# ADR 0155: Hosted MCP, the Member Blocklist, Subscription Pauses and Storage Links in Place

- Status: Proposed
- Date: 2026-10-30
- Decider: B16 (RRR-240), for the owner's review
- Addresses: parity gaps G-248, G-269, G-274 and G-285 (parity audit of 2026-10-28); requirements S10.2-04, S10.1-02, S8.5-02, S4.8.1-07, S16-07, S14.7-02, S17-04
- Migrations: 3050 to 3053, and the notification seed 3059 (range 3050 to 3059)
- Amends: ADR 0024 item 2 (every MCP call uses an API key); extends ADR 0033 decision 55 (connected apps)

## Context

The parity audit found four gaps that competitors close and XOS did not: an MCP server reachable by Claude and ChatGPT without a local install (G-248), a way to keep certain addresses out of an org (G-269), a self-serve pause between seasons (G-285), and Drive and OneDrive files linked in place without pasting tokens (G-274). XOS already had the parts each one builds on: per-org OAuth apps on Supabase Auth's OAuth server (ADR 0055, 1563), Aurora's proposal queue (0650), the read-only guard of cancellation and dunning (1063, 1353) with A107's plan-limit rules (ADR 0081, 2070), and the storage connectors (0625).

## Decisions

### D1. Hosted MCP

1. **Transport.** Stateless Streamable HTTP (MCP 2025-06-18; 2025-03-26 accepted), one endpoint: `/api/mcp` on Atlas and `/mcp` on the API host, rewritten to `/api/mcp`. There is no `Mcp-Session-Id` and no server-initiated stream: GET and DELETE answer 405, a request answers `application/json`, a notification answers 202 with no body. `initialize` negotiates from `params.protocolVersion` and offers 2025-06-18 or 2025-03-26, never 2024-11-05 over HTTP; later requests read `MCP-Protocol-Version` (missing means 2025-03-26). A batch, a body over 1 MB, a wrong Content-Type or Accept, a foreign Origin and an unsupported version are refused. The endpoint answers 404 until `XOS_MCP_HOSTED=on`.
2. **Credentials.** Only an OAuth 2.1 access token of an app registered in the org is taken: a Supabase Auth JWT with `client_id`, checked with `app.my_oauth_access` as the token itself and cached 30 seconds per token hash (the cache gates the endpoint only). API keys stay on the stdio server (`xos-mcp`). This amends ADR 0024 item 2, which said every MCP call uses an API key. A missing, foreign or revoked token answers 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/<path>"`.
3. **Connectors.** Dynamic client registration stays off (ADR 0055 decision 15). Claude and ChatGPT connectors are per-org OAuth apps an Admin registers from a preset (`app.register_mcp_connector`, `app.mcp_connectors`) with default capability groups, never a Restricted one; the person pastes the client id into the assistant's advanced OAuth settings. `/oauth/authorize` without `scope` takes the connector's defaults (`app.oauth_default_scopes`, for members of the app's org only).
4. **Discovery.** Protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource`, `/mcp` and `/api/mcp` under it, and authorization-server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`. Every URL is built from the requesting host's origin, so the issuer matches on either host and without `XOS_API_HOST`. Protected-resource metadata answers 404 while the endpoint is off; authorization-server metadata is always served, since it describes `/oauth/authorize` and `/oauth/token`. S256 only, public clients only, no registration endpoint.
5. **Resource indicators.** `/oauth/authorize` and `/oauth/token` take a `resource` (RFC 8707) only when it is the MCP or API URL on either host, and never send it on to Supabase Auth. Known limit: Supabase Auth issues tokens with `aud` authenticated, so a token is not bound to its resource.
6. **In-process API.** Tools call the public API in process with the same token, forwarding `X-Forwarded-For`, `traceparent` and `x-request-id`, so rate limits and the org IP allow-list judge the real caller. An org with an IP allow-list must allow its AI provider's addresses (the MCP guide says so).
7. **Subprocessors.** What an agent reads goes to the customer's own AI provider at the customer's direction. Anthropic and OpenAI do not become XOS subprocessors, and the Subprocessor List does not change.
8. **Copy.** MCP tool and server strings stay en-US only (ADR 0024 decision 4).

### D2. Agent writes are proposals

1. Every hosted write tool (`xos_create`, `xos_update`, `xos_action`, `xos_delete`) records a proposal in Aurora's queue (`app.propose_agent_change` into `app.ai_suggestions`, 0650) and never writes. The operation must lie within the person's grant to the app (`agent_outside_grant`), never reach a Restricted group (`agent_operation_restricted`) and never be Aurora's own (ids starting with `ai` or `aurora`). At most 100 wait per person and app.
2. Proposals are not Aurora model calls: they need neither the `aurora_ai` plan feature nor the Admin switch, and they are not metered (no `app.ai_usage` row). The operator console counts only Aurora's own requests.
3. **The database enforces it.** A connector token is a full credential for `/v1` and PostgREST within its grant, so `private.refuse_read_only_org` (t15) and `private.guard_share_link` refuse any write of a connector session outside the trusted operation `agent_proposal` (`agent_write_needs_review`). The check reads the JWT claim first, so other sessions pay nothing. Tables exempt from t15 rely on their row level security. This extends ADR 0033 decision 55. Other OAuth apps are unchanged.
4. The person confirms each proposal one at a time in Personal settings, Connected apps; there is no "confirm all" (a multi-step agent is G-234, post-launch). Confirming runs the named public operation with the person's own Atlas session, with `Idempotency-Key` the suggestion id and `If-Match` the etag the agent read, so a stale proposal fails safely and returns to Proposed with the reason. The UI shows the SDK's own summary of the operation as the action; the agent's summary is shown only as its note. The SDK summary is en-US for every locale, as MCP strings are (ADR 0024 decision 4); the panel's own labels, the refusals and the notification are in en-US and es-US. Translating operation summaries is left for when the SDK catalog gains locales. The confirming call is the person's Atlas session bound to the proposal's org, as their browser would send it, with the incoming request's address and trace, so that org's IP allow-list, MFA policy and session lifetime judge the person.
5. An app session or an API key never confirms or applies an agent proposal (`ai_suggestion_needs_person`, trigger `t14_agent_needs_person`, which sorts before t15 so its rule is the one a connector hears). A connector session may withdraw its own app's proposal. It is a trigger, not a redefinition of `app.transition_ai_suggestion`, because P6 (2830) redefines that function too.
6. Proposals expire after 7 days (0650's default) and at once when the person's grant ends (`t91_expire_agent_proposals`); a re-consent (`oauth_regrant`) does not end them. Removing the app ends its grants, sessions, connector and proposals.
7. The person hears `agent.change_proposed` in the Inbox and by push, never by email: the body names the app and the operation, never the agent-written summary. One unread notice per person and app.

### D3. Member blocklist

1. Org-level entries, each an Email or a Domain; a Domain matches that domain and its subdomains, ignoring case. At most 1,000 live entries.
2. Every new membership is checked by `t12_refuse_blocked_member` (before insert on `app.memberships`), whoever acts, so invitations, invitation links, approved requests, verified-domain joins, single sign-on just in time and SCIM are covered, and every later path. `app.invite_member` tells the inviter why (`invite_blocked`), after its capability and role checks; everyone refused hears the same generic sentence (`member_blocked`). SCIM asks `app.scim_email_blocked` before creating the auth user and answers 400 `invalidValue`, keeping 409 for uniqueness.
3. Matching reads `auth.users.email`, lowercased, confirmed or not, since an invitation link needs no confirmed address. Service accounts (provider `xos_service_account`) and people without an email are never refused.
4. Existing members are never removed automatically; the panel counts those an entry matches. Adding an entry revokes matching pending invitations and declines matching pending requests to join.
5. The org's verified domains, and their parents, cannot be blocked; one address inside them can. Entries are Internal, like invitation addresses, protected by their read policy (`org.members.manage`).

### D4. Subscription pause

1. Self-serve, by the Owner (`org.billing.manage`) with step-up, in Billing and Plan. Only an active org paying a monthly self-serve plan through Stripe can pause; annual plans, trials (XOS trials in the database, Stripe trials read from Stripe), partner-billed orgs, sandboxes and read-only orgs cannot.
2. A pause lasts 1 to 6 whole months, counted in UTC. It starts at the end of the paid period and resumes exactly N months later, so the org keeps what it paid for. In Stripe it is `pause_collection` with behavior `void`, resuming one hour before the XOS resume so the boundary invoice is collected.
3. While paused the org is read-only through the same guard as cancellation and dunning, with the reason `paused`. Nothing is deleted, every read and export works, and the deletion and purge schedules do not change. A107's personal-table rule applies, factored into `private.personal_write_allowed`: members keep their preferences, consents, legal acceptances and reading marks, and can leave.
4. The Owner can resume at any time. Before the start this only removes the pause; after it, Stripe starts a new period now with no proration and charges it, and a failed charge enters dunning as usual. A subscription in Stripe's `paused` status (a trial that ended without a card) is resumed with a new period, and asks for a payment method when Stripe needs one.
5. A Stripe-side pause is mirrored as an open-ended pause (source Stripe). Stripe does not order its events, so the sync takes each event's created time: an event older than the open pause, or than the last pause that ended, changes no pause. Stripe clearing an Owner pause within two hours of its resume ends it on schedule.
6. Cancellation, a deletion request and Stripe deleting the subscription end a pause as Canceled; a paused org can be canceled.
7. XOS never holds funds: Stripe bills, XOS only records. Billing opens with the Stripe keys; live mode needs no separate switch.
8. Known limits: prorations created before a scheduled pause starts land on the voided invoice; the billing portal can still change the plan during a pause.

### D5. Storage link-in-place

1. Google Drive and OneDrive/SharePoint connect with OAuth 2.0 authorization code, PKCE S256 and refresh tokens, on owner-registered platform apps. Google asks for `drive.readonly` with `access_type=offline` and `prompt=consent`; that scope is restricted and needs Google's verification. Microsoft uses the common tenant and `offline_access Files.Read.All User.Read`. The callback is `/oauth/integrations/callback`, under the reserved `oauth` prefix.
2. The state is bound to the person and the connection, lives 10 minutes and works once; unknown states are counted and rate limited (10 per person in 15 minutes), answered as a status rather than an error so the count holds. The read-only backup login (`xos_backup`) can read the state table, as it reads every table in app, private and xpms so pg_dump can lock and copy it (1650, ADR 0033 decision 47); a verifier there is single use, expires in 10 minutes and is worthless without the provider's code, which never reaches the database. This departs from review correction C34, which asked to revoke that read, and is left for the owner's review.
3. The refresh token lives in Vault as the connection's JSON credential. The worker and `storage-browse` refresh it 5 minutes before the access token expires and store the rotated tokens; `invalid_grant` raises `credential_revoked` with the reconnect copy. Secrets, codes and tokens are cut from every error.
4. The connection is one Admin's account, so an Admin chooses a linking folder (`provider_settings.link_root_id`, and the drive for OneDrive); only connections with one are offered, and document writers browse and link only inside it (`storage_outside_link_folder`), checked by walking at most 20 parents. A narrower alternative is `drive.file` with the Google Picker, where the person chooses each file; it is left for the owner's review.
5. Browsing and linking run in a new Edge Function, `storage-browse`, which checks the caller first (`app.authorize_storage_link`) and only then reads the credential. Atlas has no service role and never reads credentials. Dropbox stays on pasted tokens; storage import in the import wizard stays out (S17-04 stays Partial).

## Consequences

- OpenAPI v1 is unchanged: no operation, field or enum value is added.
- The Edge Function `storage-browse` is new and needs the four OAuth secrets; `integration-worker` and `stripe-webhook` are redeployed.
- A Google Sheets link read by the import worker still uses the stored access token without renewing it; its trace row (S4.6.2-01) does not move.
