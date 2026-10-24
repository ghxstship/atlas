# @xos/integrations

The Section 17 integrations: the connector framework over Vault credentials, external identifier maps and
sync runs (`src/framework`), one connector per provider (`src/connectors`), the inbound webhook handlers
(`src/inbound`), warehouse delivery (`src/warehouse`), the Zapier and Make app definitions (`automation/`) and
the connector settings panel Atlas shows on Settings, Integrations (`src/settings`).

Every provider client is injected. Tests use fake transports (`test/doubles.ts`), so no test reaches a real
provider; the `integration-worker` Edge Function passes `httpFromFetch(fetch)`. Owner setup for the runtime
(deploying the workers, Edge Function secrets, provider apps) is in `infra/runbooks/integrations.md`.

## Credentials

A connection's credential is stored in Vault through `app.store_integration_credential` and read only by the
service role. It is either the token or key alone, or JSON with named string fields
(`src/framework/support.ts`, `parseCredential`). It is never logged: connectors raise `IntegrationError`s, and the
UPS and FedEx connectors cut the client ID, client secret and access tokens from any provider message before it
becomes the run's error.

## Carrier tracking: UPS and FedEx client credentials (owner step)

UPS and FedEx issue access tokens that expire within hours (UPS after 4 hours, FedEx after 1), so a stored token
stops working the same day. Their connections store the carrier developer app's **client ID and client secret**
instead (`{"client_id": "...", "client_secret": "..."}`, kind API Key). On each run the connector mints an access
token with the OAuth 2.0 client-credentials grant (UPS `POST /security/v1/oauth/token` with HTTP Basic, FedEx
`POST /oauth/token` with the pair in the form body), keeps it per connection until five minutes before it
expires, and on a 401 mints a new one and retries the call once (`src/connectors/shipping/index.ts`). DHL keeps
its API key (`dhl-api-key`).

The connector calls the carriers' production hosts (`onlinetools.ups.com`, `apis.fedex.com`), so it needs
production credentials. Sandbox credentials (UPS CIE, FedEx test keys) are refused with 401 and move the
connection to Needs attention.

Only someone holding the carrier account can create these. Never paste the values into the repository, an issue
or a chat; they go into Atlas only.

1. **UPS.** Sign in at developer.ups.com with the UPS account that ships, open Apps, Add Apps, link the shipper
   account and add the **Tracking** API product. Open the app and copy its Client ID and Client Secret.
2. **FedEx.** Sign in at developer.fedex.com with the FedEx account, create a project (or open the existing one)
   with the **Track API**, and request its production key. Copy the API key (the client ID) and the secret key
   (the client secret).
3. **Atlas.** As an Admin with `org.integrations.manage`, open Settings, Integrations, add a Shipping: UPS (or
   FedEx) connection, enter the Client ID and Client secret, and select Store credential. Then select Connect.
   The form's help text names where each value comes from, in en-US and es-US.
4. **Verify.** On the connection, choose Refresh tracking and Sync now. Last synced shows the time and a tracked
   shipment shows its latest scan, and the latest runs show Succeeded:

   ```sql
   select sync_run_state, error_code from app.integration_sync_runs
   where sync_scope = 'Tracking Refresh' order by id desc limit 5;
   ```

   A run more than 4 hours later (UPS) or 1 hour later (FedEx) also succeeds, because the worker mints a new
   token.

A connection that stored a bearer token before this change fails its next run with `credential_incomplete`
("UPS needs the client ID and client secret of a UPS developer app") and shows Needs attention until the pair is
stored and the connection is reconnected. Rotating the secret at the carrier only needs step 3 again: a token
minted from the old pair is never reused.
