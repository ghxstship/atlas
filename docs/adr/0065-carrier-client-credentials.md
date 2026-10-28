# ADR 0065: UPS and FedEx Mint Their Access Tokens with the Client-Credentials Grant

- Status: Proposed
- Date: 2026-10-23
- Decider: A105 (RRR-150) took the decisions below as the follow-up to A19 and A83 (connector framework and
  integration runtime, ADR 0039)

## Context

The shipping connector (`packages/integrations/src/connectors/shipping`, migration 0634) sent each connection's
stored credential to UPS and FedEx as a bearer token. Neither carrier issues long-lived tokens: an app's client ID
and secret buy an access token with the OAuth 2.0 client-credentials grant, valid for 4 hours at UPS and 1 hour at
FedEx. A stored token therefore stopped working the same day, every tracking run after it failed with
`credential_refused`, and the connection moved to Needs attention (requirement S17-09). DHL's tracking API takes a
permanent API key and was not affected.

## Decision

1. **The connection stores the app's client ID and secret.** The credential stays in Vault through
   `app.store_integration_credential`, as JSON `{"client_id": ..., "client_secret": ...}` with kind API Key; no
   migration and no API change (the v1 operation already takes any secret). `parseCredential` accepts the pair with
   an empty `token` only for a provider that `usesClientCredentials` (UPS, FedEx); any other provider given a pair
   fails as `credential_malformed`, not later with an empty bearer token. Atlas's credential form asks UPS and FedEx
   connections for Client ID and Client secret (a password field) with each carrier's help text. The server action
   reads the connection's provider under row level security to pick the form, and builds the JSON with
   `clientCredentialSecret`, the one writer of the format. Other providers keep the pasted secret.
2. **The connector mints on demand and caches per connection.** UPS: `POST /security/v1/oauth/token` with HTTP
   Basic; FedEx: `POST /oauth/token` with the pair in the form body. The token is kept in a `CarrierTokenCache`
   keyed by connection until five minutes before its stated expiry (half its life when it lives under ten
   minutes), so a run mints once at most, or twice when a 401 forces a refresh (decision 3), and a warm worker
   isolate reuses the token across runs. The entry carries a SHA-256 fingerprint of the pair, so a rotated secret
   or a different account never reuses an old token. The cache is memory only: a cold isolate mints again, which
   costs one request.
3. **A 401 is retried exactly once.** A carrier may drop a token before its stated expiry. On a 401 from a tracking
   call the token is forgotten, a new one minted and the call repeated once; a second 401 is `credential_refused`
   as before. A refused token request (wrong pair, sandbox keys against production) is `credential_refused` too.
4. **Credentials never reach an error or a log.** Provider error bodies can echo a request. The token path's HTTP
   client cuts the client ID, the secret, the Basic value and the access tokens from a refusal's body before the
   status check quotes its first 500 characters, so the cut never leaves part of a secret. Each value is matched
   raw, form- and URI-encoded and JSON-escaped (with and without `\/`). Every error the path raises is scrubbed the
   same way, keeping its code and retry and connection flags, before it becomes the run's `error_message` and the
   connection's last error. Nothing in the path logs.
5. **No fallback to a stored token.** A UPS or FedEx connection without the pair fails with
   `credential_incomplete`, naming what to store. A token stored earlier would have expired anyway.

## Consequences

- The owner step (create the carrier apps, enter the pair) is in `packages/integrations/README.md`; the runbook
  line for `infra/runbooks/integrations.md` section 3 is applied by the orchestrator.
- The connector calls production hosts only, so carrier sandbox credentials are refused; testing against UPS CIE or
  the FedEx sandbox would need a host setting on the connection, not built.
- `upsCarrier` and `fedexCarrier` became functions taking the cache (the worker's by default), so tests pass their
  own; `dhlCarrier` is unchanged.
