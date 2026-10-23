# ADR 0047: Automation Engine

- Status: Proposed
- Date: 2026-10-21
- Decider: Orchestrator; built and recorded by A91 (RRR-136)
- Resolves: finding A65-010 (work package WP10); trace rows S4.5.6-20 and S7.3-08

## Context

Section 7.3 lists `automations` and `automation_runs` in the workflow engine, Section 4.5.6 item 20 is Settings,
Automations, and Section 16 sells automations on Pro and above. `automations` was a plan feature in `plans.yaml` and
`org.automations.write` a capability (0203), but there were no tables, no operations, no runner and no settings content.

## Decision

### 1. Triggers are domain events from the webhook catalog

An automation's trigger is one event type of `private.domain_event_types`, the catalog webhooks subscribe to
(`app.domain_event_catalog`, `GET /webhook-events`). There is no second list. The catalog has grown well past the 41
types ADR 0016 counted: every module adds its own rows, and automations can use all of them.

What an automation sees is the body a webhook receives: `id`, `type`, `occurred_at`, `project_id`, `subject.table`,
`subject.id` and `data`, the event's named, non-restricted columns (ADR 0016 item 12).

### 2. Conditions are declarative, and rows

- **Shape.** A condition is a dotted path into the event, an API filter operator (ADR 0003, `app.filter_operator`) and
  a text value. Conditions combine as `{"all": [...]}` or `{"any": [...]}`, with one level of groups and at most 20
  conditions and groups in all. An empty list holds. Nothing is evaluated as code, and nothing reaches SQL as text.
- **Evaluation rules,** the same in SQL and TypeScript:
  - Each path segment reads an object key, or an array index when it is digits. A missing value and JSON null are
    both missing, and every operator but `is_null` is false on a missing value.
  - `eq` compares numbers numerically with a numeric value, booleans with `true` or `false`, and strings exactly.
    `ne` is not `eq`.
  - `lt`, `lte`, `gt` and `gte` compare numbers numerically and strings by code point.
  - `in` is `eq` against any of the comma-separated values.
  - `contains` folds ASCII case for strings, or finds an equal element in an array.
- **Storage.** Conditions are stored as rows (`app.automation_conditions`), not a JSON column (ADR 0002). The
  document form is what the API, Atlas and `packages/schemas` exchange.
- **Validation.** The Zod schemas in `@xos/schemas/automations` render as `packages/schemas/automation.schema.json`
  (`generate:automations`). The SQL validators `private.automation_conditions_refusal` and
  `private.automation_actions_refusal` mirror them.
- **Two evaluators that agree.** The database evaluates when an event happens (`private.automation_conditions_match`).
  Atlas evaluates in the browser to test a draft (`evaluate.ts`). Both, and both validators, run the shared vectors in
  `packages/schemas/src/automations/vectors.json`. pgTAP 1480 embeds the same JSON, and the schemas tests fail when
  the copies differ.

### 3. Actions are public API calls made as the owner

| Action          | API operation                   | What it does                                                                              |
| --------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `create_task`   | `records.create`                | A Task under the project's engagement root, optionally due at 17:00 on the org's calendar |
| `update_status` | `records.transition`            | Moves the subject record, with the blocker or replan reason Blocked and Deferred need     |
| `assign`        | `records.update`                | Makes a member the subject record's owner                                                 |
| `add_comment`   | `comments.postOnSubject`        | Comments on the event's subject                                                           |
| `notify`        | `automationRuns.notify`         | Notifies a member (`automation.notice`) about the event's subject                         |
| `call_webhook`  | `automationRuns.deliverWebhook` | Queues a signed delivery of the event to one of the org's endpoints (the 0510 pipeline)   |

- **Owner token.** The worker mints an HS256 JWT for the owner's auth user, signed with the project's JWT secret
  (`XOS_API_JWT_SIGNING_KEY`, which `api-token` and A83's chat sessions also use). It is valid for two minutes, minted
  per action, and never stored or logged.
  - Its claims are an ordinary session: `sub`, `role` and `aud` authenticated, the org it is bound to (`org_id`),
    `amr` method `xos_automation`, and `xos_automation_id` and `xos_automation_run_id`.
  - Row level security and capabilities decide every write.
  - The service role only claims jobs and writes the runs ledger. It never writes domain rows.
- **Who the owner is.** An automation runs as whoever last changed its trigger, conditions or actions, or turned it
  on. An admin cannot make someone else's automation act as that person.
- **Templates.** Titles and bodies may name event paths in double braces, such as `{{data.title}}`. The worker fills
  them in and cuts each to its field's limit.
- **Two new operations, scoped to a run.** `automationRuns.notify` and `automationRuns.deliverWebhook` act only inside
  a running run of the caller's own automation.
- **One general operation.** `comments.postOnSubject` exists because `commentThreads.create` takes the API's bare
  table names, which the schema-qualified `app.comment_subjects` never matches. Before it, no API client could open a
  thread.

### 4. The runs ledger, idempotency and retries

- **Idempotent per event.** `app.automation_runs` has one row per automation and domain event. A unique index makes
  the fan-out idempotent per event.
- **What a run records.** The event body as its input, the owner it acted as, attempts, error code and message,
  start, end and duration.
- **Steps.** `app.automation_run_steps` holds each action's operation, request, trimmed response, HTTP status, error
  and duration.
- **The job queue.** The fan-out trigger (`t88_fan_out_automations` on `app.domain_events`) queues an `automation.run`
  job on the 0510 queue.
- **Retries.** Five attempts, 30 seconds doubling, capped at 6 hours (`app.finish_job`).
  - A retried run skips the steps that already succeeded.
  - Every POST carries an `Idempotency-Key` per run and action, so a retry never repeats a write the API already made.
- **Failure classes:**
  - 401 and 403: the API refused the owner. The run fails and the automation pauses.
  - 408, 409, 425, 429, 5xx and network errors: retried through the queue.
  - Anything else (a refusal, or a 404 where row level security hides the target): the run fails for good, and the
    owner is told, at most once an hour per automation.
- **Manual retry.** A person can retry a failed run (`automationRuns.retry`).

### 5. Fail closed

Before each run, `app.begin_automation_run` checks that the owner still has an active membership, holds
`org.automations.write`, and has a sign-in. If not, the run fails, the automation pauses (`paused_at`,
`pause_reason`), and the org's automation managers and the owner, if still a member, receive `automation.paused`.
Turning the automation on again makes the person who did it its owner.

Runs of an automation that was turned off, deleted, downgraded or made read-only before the run started are recorded
Skipped.

### 6. Loop protection and rate limits

- **Depth.** When an event comes from a request carrying `xos_automation_run_id`, the new run is one level deeper than
  that run. Past `private.automation_max_depth()` (3), the run is recorded Skipped (`loop_depth`) and never queued.
  This bounds an automation that triggers itself and chains between automations alike.
- **Rate.** Past `private.automation_hourly_run_limit()` (1,000) runs started in an hour, new runs in the org are
  recorded Skipped (`rate_limited`).
- **API rate limit.** The API's own limit per user (600 a minute, 1040) also applies to the owner's calls; a 429
  retries.

### 7. Plan gating and limits

- **The feature.** Creating, changing or turning on an automation needs the `automations` feature: Pro, Team and
  Enterprise (ADR 0020, unchanged by ADR 0035).
- **No numeric quota.** ADR 0035 sets seat, engagement and Aurora limits and no automation quota, so the feature is
  the only plan limit. The depth and hourly limits in item 6 are operational, the same on every plan. A per-plan quota
  would need a new limit code in `plans.yaml` and the plan seed.
- **Downgrades.** After a downgrade an org keeps its automations: they stop starting runs, and they can be turned off
  and deleted, not changed or turned on (Section 16).

### 8. Calendars

`due_in_days` resolves to 17:00 on the org's calendar (`private.org_today` and `private.org_time_zone`), never to a
UTC date. There are no scheduled or time-based triggers yet; when they come, they fire on the org's calendar.

### 9. Deployment

- **The function.** `supabase/functions/automation-run` runs one pass of the worker
  (`packages/data/src/automation-runner.ts`, carried by the Edge bundle). It is called every minute with the service
  key, like the other workers (`xos_worker_automation_run`).
- **Secrets.** `XOS_API_JWT_SIGNING_KEY` and `XOS_APP_URL` (Atlas, whose `/api/v1` the actions call).
- **Its own loop.** The worker keeps its own job loop beside A83's integration runtime. Both claim from the 0510 queue,
  each its own job kind.

### 10. Atlas

- **Where it lives.** The page is the existing sitemap node `settings.automations` (Section 4.5.6 item 20), already
  hand-written (`settings-identity.txt`). No sitemap node is added and ADR 0006 is unchanged.
- **What it shows.** The page carries only a small client panel: the list, the on switches and the recent runs.
- **What loads on demand.** The editor (trigger, conditions, actions and the sample-event test) and the run details
  load through `next/dynamic` when opened (ADR 0027).

### 11. Notifications

The `automations` category carries `automation.notice`, `automation.failed` and `automation.paused`. The seed moves
to 1489.

## Consequences

- An org whose IP allow-list is on refuses the owner's token from the worker's network. The run is refused and the
  automation pauses with the reason `owner_access_refused`. Until the allow-list exempts server-minted automation
  tokens, or lists the worker's egress, automations and allow-lists do not mix.
- The owner's token is a full session of the owner for two minutes. Narrowing it to the capability groups each action
  needs, through the scope mechanism API keys use (0936), is a follow-up.
- The 0510 queue has no lease expiry, so a worker that dies mid-run leaves its job Running. This holds for every job
  kind.
- Recipients and assignees are fixed members. Following the record (its owner, its accountable person) is a follow-up.
- Three copies of the HS256 session signer now exist: `api-token`, A83's chat sessions and the automation worker. They
  could share one helper.

## Migrations

1480 (definitions, evaluator, validators and RPCs), 1481 (runs ledger, fan-out, worker API and run-scoped
operations), 1489 (notification kind seed), each with its pgTAP test.
