# Database probes

A probe answers questions about the hosted platform that the repository and Supabase's documentation cannot. A
person runs it by hand against the staging branch. Nothing here is a migration, nothing here runs in CI, and no
agent runs a probe against a hosted project.

## 0169: the direct-endpoint probe

Work package 0 of [ADR 0169](../../../docs/adr/0169-session-gate-on-the-data-endpoint.md). The owner approved it
in the sessions of 2026-11-15 and 2026-11-20 (owner decision 2 of that record): throwaway objects on staging and
a few requests.

| File                                      | What it is                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `0169-direct-endpoint-probe.sql`          | Setup. Creates the probe objects. Run it in the staging branch's SQL editor. |
| `0169-direct-endpoint-probe.sh`           | The requests. Run it on your own machine. It prints one line per fact.       |
| `0169-direct-endpoint-probe.teardown.sql` | Removes every probe object and lists what is left, which must be nothing.    |

### What the setup creates

In its own schema, `probe_0169`: five functions and one table with four columns.

Outside that schema there are five things, because PostgREST only reaches an exposed schema, and a Storage or
Realtime policy can only be asked a question from a policy on Storage's or Realtime's own table:

1. `api_public.probe_0169(text, text)`, a function only `authenticated` may execute;
2. one row in `storage.buckets`, the private bucket `probe-0169`, which never holds an object;
3. the policy `probe_0169_storage` on `storage.objects` (insert, to `authenticated`), which never admits a row;
4. the policy `probe_0169_realtime` on `realtime.messages` (select, to `authenticated`), which admits only topics
   that start with `probe-0169:`;
5. `probe_0169.changes` in the `supabase_realtime` publication.

Both policies are permissive and wrapped in `CASE`, so for every real bucket and every real topic they are false
without calling anything, and a false permissive policy changes no decision. The setup reads no application
table. Every lock waits at most three seconds (`lock_timeout`); if one is not free, the file rolls back whole
and you run it again.

The functions return and log header names, the values of forwarding headers (addresses), claim names, and a
12-character fingerprint of the session id. They never return or log a token, an API key, a person's id or an
email.

### Before you start

- **Staging is a branch, not the project named staging.** The hosted project `xos-atlas-staging` is production
  (`promote-to-production.md`). The probe runs on the persistent staging branch, the one
  `atlas-staging.ghxstship.tech` uses. The script refuses the production project's URL.
- You need the dashboard's SQL editor on the staging branch, a test person who can sign in to staging Atlas, and
  on your machine `bash`, `curl` and Node.js 22 or later.
- Plan ten minutes. Run the teardown in the same sitting.

### Steps

1. **Setup.** In the Supabase dashboard, switch to the staging branch, open the SQL editor, paste
   `0169-direct-endpoint-probe.sql` and run it. The result is seven rows, each `present`. If it reports a lock
   timeout, nothing was created; run it again.

2. **Values for the script.** Sign in to `https://atlas-staging.ghxstship.tech` as the test person. On any Atlas
   page open the browser's developer console and run:

   ```js
   const live = await (await fetch("/auth/realtime")).json();
   console.log(live.url, live.key);
   copy(live.token);
   ```

   The first line printed is the staging branch's URL and its publishable key. The token is now on the
   clipboard, not on the screen. It expires within the hour, and within 15 minutes once the token lifetime
   change of ADR 0169 is applied.

3. **Environment.** In a terminal, in this directory. `read -rs` keeps the token out of the shell history and
   off the screen:

   ```sh
   export PROBE_SUPABASE_URL='https://<the staging branch ref>.supabase.co'
   export PROBE_PUBLISHABLE_KEY='<the key printed in step 2>'
   read -rs PROBE_ACCESS_TOKEN && export PROBE_ACCESS_TOKEN
   ```

   Paste the token and press Return. The script takes no arguments and reads no file; it reads only these
   variables, and never prints the key or a token.

4. **For question 5: an OAuth app token.** The rest of the probe runs without this step, but question 5 stays
   open until it is done: skipping it selects nothing. In the same browser session, register a test app in
   staging Atlas (the organization's Settings, Integrations, OAuth apps: an app name, the redirect URI
   `http://127.0.0.1:8976/callback`, Register app) and copy the client ID it shows. The test person must be a
   member of that organization. Then run the authorization code flow with PKCE:

   ```sh
   VERIFIER="$(openssl rand -base64 48 | tr -d '=+/\n')"
   CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')"
   echo "https://atlas-staging.ghxstship.tech/oauth/authorize?response_type=code&client_id=<client id>&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback&scope=projects&code_challenge=$CHALLENGE&code_challenge_method=S256&state=probe"
   ```

   `scope` is required. Atlas refuses an authorization request without it for any app that is not an MCP
   connector, with HTTP 400 and "This authorization request is invalid (scope)". Its value is one or more
   capability groups, and an app registers none in advance: any group works. `projects` is the one to use,
   because consent to it needs no second factor; `data`, `org` and `audit` reach Restricted data or the
   organization's control and ask for step-up at consent.

   Open the printed address in the browser where the test person is signed in and choose Allow on the consent
   page. The browser lands on a page that does not load; copy the `code` value from its address bar. Then:

   ```sh
   read -rs CODE
   export PROBE_APP_TOKEN="$(curl -sS https://atlas-staging.ghxstship.tech/oauth/token \
     --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" \
     --data-urlencode redirect_uri=http://127.0.0.1:8976/callback \
     --data-urlencode 'client_id=<client id>' --data-urlencode "code_verifier=$VERIFIER" |
     node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).access_token ?? ""')"
   unset CODE VERIFIER CHALLENGE
   ```

   The app must be authorized by the same browser session whose token is in `PROBE_ACCESS_TOKEN`, or the
   comparison in question 5 says `other-session` for the wrong reason. Without `PROBE_APP_TOKEN` the script
   prints `Q5.app skipped` and `Q5.verdict unanswered`, and everything else still runs. If the token request failed, the variable is empty
   and the script prints the same line; `echo "${#PROBE_APP_TOKEN}"` prints the token's length, which is 0
   then, without showing it. Run the script's requests again with this step done before recording an answer to
   question 5.

5. **Run.**

   ```sh
   ./0169-direct-endpoint-probe.sh | tee "$HOME/probe-0169-output.txt"
   ```

   It takes under a minute. The output holds your public address and no secret. Keep the file for the record in
   step 8.

6. **Teardown.** In the same SQL editor, paste `0169-direct-endpoint-probe.teardown.sql` and run it. The result
   must be **zero rows**. Any row names an object that is left; run the file again. It can be run any number of
   times.

   If the one row left is `bucket | storage.buckets: probe-0169`, running the file again does not help. The
   bucket then holds an object the probe did not create (the probe's policy never admits one, so it came from
   the dashboard or a secret-key upload), and the teardown leaves a bucket that holds anything. The SQL editor
   may not show the warning that says so. Delete the bucket in the dashboard (Storage, the bucket `probe-0169`,
   Delete bucket), then run the teardown once more; the result must then be zero rows.

7. **Confirm nothing is left.** Run the script once more. It must stop with
   `the probe function is not on this project (HTTP 404)` and exit status 3. In the dashboard, Storage must show
   no bucket `probe-0169`. Then `unset PROBE_ACCESS_TOKEN PROBE_APP_TOKEN`, and remove the test app from
   Settings, Integrations if you made one.

8. **Record.** Add the output and the date to `infra/runbooks/hosted-security-settings.md` under "Session gate on
   the data endpoint (ADR 0169)", and tell the orchestrator which branches below it selected.

Exit status of the script: 0 it ran and printed its lines; 2 bad input or a missing tool; 3 the probe objects
are not on that project, or the project refused the token.

### What each line means

Every line is a name, then a value. `yes` and `no` are answers; `unanswered (...)` means the request did not
reach the point where the question is asked, and the text says why.

| Line                                                 | Meaning                                                                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target.host`, `target.run`                          | The project the requests went to, and this run's id.                                                                                                                                                  |
| `rest.echo.status`                                   | HTTP status of the first call. 200, or the script stops.                                                                                                                                              |
| `rest.database_role`                                 | The database role PostgREST ran the call as: `authenticated`.                                                                                                                                         |
| `rest.header_names`                                  | Every request header the database can read on a PostgREST call. Names only.                                                                                                                           |
| `rest.address_headers`                               | The values of the forwarding headers among them.                                                                                                                                                      |
| `Q1.chain.plain`, `Q1.chain.plain_again`             | `X-Forwarded-For` as the database saw it on two identical requests.                                                                                                                                   |
| `Q1.chain.spoofed`                                   | The same when the script itself sent `X-Forwarded-For: 203.0.113.77`, an address no machine has.                                                                                                      |
| `Q1.x_real_ip.*`                                     | `X-Real-IP`, plain and when the script sent `203.0.113.78`, and whether a client can set it.                                                                                                          |
| `Q1.own_address`                                     | The address the platform recorded for your machine: the first entry of the plain chain.                                                                                                               |
| `Q1.trusted_proxy_hops`                              | How many entries follow your address in the chain. This is the value for `xos.trusted_proxy_hops`.                                                                                                    |
| `Q1.verdict`                                         | `consistent: ...` when your address sits at the same place from the right with and without a client-sent chain. `not-proven: ...` otherwise, with the reason.                                         |
| `Q2.custom_header`                                   | Whether a 256-character `X-Xos-Probe` header reached the database unchanged: `reached`, `altered` or `not-reached`.                                                                                   |
| `Q3a.storage.policy_evaluated`                       | The Storage API evaluated the probe policy on `storage.objects`. If `no`, the Storage lines are absent.                                                                                               |
| `Q3a.storage.headers`, `.claims`, `.claim.*`         | Whether that policy can read `request.headers`, `request.jwt.claims`, and the `session_id` and `aal` claims.                                                                                          |
| `Q3a.storage.x_forwarded_for`, `.x_real_ip`          | Whether those headers are present for the policy.                                                                                                                                                     |
| `Q3a.storage.custom_header`                          | Whether a custom header sent to Storage reaches the policy.                                                                                                                                           |
| `Q3a.storage.own_address_hops`                       | The place from the right at which the policy finds your address in `X-Forwarded-For`, or `none`.                                                                                                      |
| `Q3a.storage.holds_when_spoofed`                     | Whether your address stays at that place when the client sends its own chain.                                                                                                                         |
| `Q3a.storage.x_real_ip_is_own`                       | Whether `X-Real-IP` is your address for the policy.                                                                                                                                                   |
| `Q3b.realtime.*`                                     | The same questions for the policy on `realtime.messages`, asked by joining private channels. Realtime evaluates it at the join.                                                                       |
| `Q3c.changes.subscribed`, `.rows_written`            | Realtime accepted a Postgres Changes subscription on the probe table, and the rows the probe wrote.                                                                                                   |
| `Q3c.changes.policy_evaluated`                       | The always-yes row arrived and the always-no row did not, so Realtime applied the table's policy.                                                                                                     |
| `Q3c.changes.headers`, `.claims`, `.claim.*`, `.x_*` | What that policy could read when Realtime decided whether to deliver each change.                                                                                                                     |
| `Q4.refusal.status`, `.body`, `.content_type`        | What a client receives when the database refuses a whole request with SQLSTATE `PGRST`, status 401, code `XS401`.                                                                                     |
| `Q4.refusal.response_header`                         | Whether a response header set by the refusal passes back through the gateway.                                                                                                                         |
| `Q4.verdict`                                         | `as-designed`, `status-only` or `different`.                                                                                                                                                          |
| `Q5.session.*`                                       | The claim names of the session token and the facts the gate reads: `aal`, the sign-in methods, whether they carry timestamps, the token lifetime, whether `session_id` is present and its row exists. |
| `Q5.app.*`                                           | The same for the OAuth app token.                                                                                                                                                                     |
| `Q5.app`                                             | `skipped: ...` when `PROBE_APP_TOKEN` is not set or is empty. Question 5 was then not asked.                                                                                                          |
| `Q5.verdict`                                         | `names-authorizing-session`, `other-session` or `no-session`; or `unanswered: ...` when no app token was sent or the project refused it before the probe function ran.                                |
| `BRANCH.address_source`                              | The script's reading of question 1.                                                                                                                                                                   |
| `DONE`                                               | The script reached its end.                                                                                                                                                                           |

Every policy evaluation also writes one line to the Postgres log that starts with `probe_0169` (dashboard, Logs,
Postgres). It holds the full header-name list a Storage or Realtime policy saw, which the yes and no answers
cannot carry. Copy those lines into the record if a `Q3` answer surprises.

### Which answer selects which branch of the design

The left column is ADR 0169's own wording; the owner decided each branch in advance (owner decisions 3, 9 and 10, in the owner's own numbering of 1 to 13).

| Question                      | Answer                                                                                                            | Selects                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The hosted address chain   | `Q1.verdict` starts with `consistent`, **and** `Q1.own_address` is the public address of the machine you ran from | The address source may become `edge` on direct PostgREST calls: the owner sets `xos.trusted_proxy_hops` to `Q1.trusted_proxy_hops` and approves the switch. API keys and app tokens are then checked per request there.   |
|                               | Anything else                                                                                                     | The address source stays `pass`. The allow-list on direct calls is the five-minute network pass, the Security Overview states that limit, and API keys and app tokens are refused there for an allow-listed organization. |
| 2. A custom header            | `Q2.custom_header` is `reached`                                                                                   | The attestation header of D3 as designed.                                                                                                                                                                                 |
|                               | `altered` or `not-reached`                                                                                        | Per-request attestation cannot work as designed. Packages 4 and 7 wait for an amendment of the ADR.                                                                                                                       |
| 3a. Storage                   | `own_address_hops` is a number, `holds_when_spoofed` is `yes`                                                     | Storage calls can be checked against the allow-list exactly, per call, instead of by the pass.                                                                                                                            |
|                               | Anything else                                                                                                     | Storage stays on the network pass.                                                                                                                                                                                        |
| 3b. Realtime channel joins    | `own_address_hops` is a number, `holds_when_spoofed` is `yes`                                                     | Broadcast and presence joins can be checked exactly at the join and at each new token.                                                                                                                                    |
|                               | Anything else                                                                                                     | Joins stay on the network pass.                                                                                                                                                                                           |
| 3c. Realtime Postgres Changes | `Q3c.changes.claims` and `.claim.session_id` are `yes`                                                            | The restrictive select policy of package 6 can compute the verdict per delivered change, as designed. Headers are not expected there; the allow-list on Postgres Changes is the pass either way.                          |
|                               | Either is `no`                                                                                                    | Package 6's Postgres Changes policy waits for an amendment.                                                                                                                                                               |
| 4. The refusal                | `Q4.verdict` is `as-designed`                                                                                     | D2 as written.                                                                                                                                                                                                            |
|                               | `status-only`                                                                                                     | D2 holds for released Compass builds, which read the status alone. The new build reads the reason from `app.my_session_gate` instead of the hint.                                                                         |
|                               | `different`                                                                                                       | The PostgREST layer is not enforced until the ADR is amended: released Compass builds would not halt safely.                                                                                                              |
| 5. The app token              | `Q5.verdict` is `names-authorizing-session`                                                                       | The control `app_mfa` is built: an app token is refused for an organization whose second-factor rule the authorizing session did not meet.                                                                                |
|                               | `other-session` or `no-session`                                                                                   | `app_mfa` is not built. The Security Overview keeps the sentence that apps and API keys act without a second factor.                                                                                                      |
|                               | `Q5.app` is `skipped`, or `Q5.verdict` is `unanswered`                                                            | Nothing. Question 5 is still open: no one has looked at an app token's claims. Do step 4 again and rerun the script. Until then `app_mfa` is neither built nor ruled out.                                                 |

The script cannot know your public address. Confirm `Q1.own_address` against the address your network shows
(your router, or your VPN's status page) before reading question 1 as proven. If you ran from behind a
corporate proxy or a VPN, that exit address is what to expect.

### What only the hosted platform can answer

The SQL and the script were run end to end on 2026-11-21 against a local stack with no application schema
(Supabase CLI 3.1.0: Postgres 17.11, PostgREST 16.5, Storage API 1.90.1, Realtime 2.154.0, Auth 2.197.0, Kong
2.8.1), including the teardown, the teardown run twice, the setup run twice, and each refusal path of the
script. The setup and the teardown were also run on a database with no Storage and no Realtime tables, where
the setup creates the four objects it can and the teardown removes them, and the teardown was run with an
object placed in the probe bucket, where it leaves the bucket and lists it. That proves the probe works. Step 4
was not walked against a running Atlas; its address has the parameters Atlas's own OAuth journey test sends
(`apps/atlas/e2e/a99-auth.spec.ts`). It answers none of the questions for the hosted project:

- **Question 1.** The local gateway is one Kong container. The hosted path has Supabase's edge in front of it,
  and the chain and hop count there are what the design needs.
- **Question 2.** Whether the hosted gateway passes, drops or rewrites a custom header.
- **Questions 3a and 3b.** The local Storage API and Realtime pass forwarding headers into the policy. Supabase
  does not document that for the hosted services, and they sit behind different infrastructure.
- **Question 4.** PostgREST alone gives HTTP 401 with the `XS401` body locally, from a function and from a
  registered pre-request function. Whether the hosted gateway leaves the status and body untouched is hosted.
- **Question 5.** The local run had no OAuth app. The app-token lines were exercised with a session token in
  that variable, which proves the comparison and nothing about a real app token's claims.

The local stack did answer question 3c for Realtime 2.154.0: a Postgres Changes policy reads the claims and no
request headers. The hosted run confirms it for the hosted version.

Three things the ADR lists as not established are outside this probe: the claims of every other sign-in method
(observe mode counts tokens without `session_id` or `amr` timestamps), the claims of the three worker-minted
tokens (read in package 8), and the hosted Auth session settings (read in the dashboard).
