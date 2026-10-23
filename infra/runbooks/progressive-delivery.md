# Progressive delivery

Section 5.1 requires two things. Releases roll out at 5, then 25, then 100 percent, with automatic rollback when the error rate regresses. Every risky feature ships behind a flag with a kill switch. XOS meets them at two levels:

| Level      | What moves              | Mechanism                                                                                  | Code                                 |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| Deployment | A new build of Atlas    | Vercel Rolling Releases at the stages in `infra/delivery/rollout.json`, judged by the gate | `infra/delivery/src/release-gate.ts` |
| Feature    | One feature, org by org | A18's flags (0540): per-org overrides as cohorts, plan gating, kill switch                 | `infra/delivery/src/flag-rollout.ts` |

There is one flag system. A18's `private.feature_flags` and `app.feature_flag_overrides` hold every flag, and `private.flag_enabled(org, flag)` decides. A rollout stage is a set of overrides whose reason starts with `rollout:<flag>:`. Manual support overrides use any other reason and are never touched by these commands. The kill switch and plan gating beat every override.

## Shipping a risky feature

1. **Add the flag** in the owning agent's migration range:

   ```sql
   insert into private.feature_flags (flag_key, description, default_enabled, required_plan_feature)
   values ('module.feature', 'What it turns on.', false, null);
   ```

2. **Gate the code.** The server reads `app.org_feature_flags(org)` once per request and hides the feature when the flag is off. Where the feature writes data, its guard or RPC calls `private.flag_enabled(org_id, 'module.feature')` and refuses with `XR001` when the flag is off, so the flag is never enforced only in the UI (Section 5, rule 1).
3. **Check cohort sizes:** `pnpm --filter @xos/infra rollout:gate flag-cohorts module.feature` prints SQL. Run it read-only.
4. **Run each stage.** Each command prints SQL. The release owner runs it with the service role in the Supabase SQL editor for staging, then for production.

   | Step  | Command                        | Wait before the next step                                      |
   | ----- | ------------------------------ | -------------------------------------------------------------- |
   | 5 %   | `flag-stage module.feature 5`  | 30 minutes, with no new errors tagged with the feature's route |
   | 25 %  | `flag-stage module.feature 25` | 60 minutes                                                     |
   | 100 % | `flag-complete module.feature` | Remove the flag in a later release (expand and contract)       |

   The cohorts are deterministic: SHA-256 of `<flag>:<org id>`, in basis points. Orgs in the 5 percent cohort stay in at 25 percent, and each flag picks its own cohort. The TypeScript and SQL buckets are pinned to the same vectors in the tests.

5. **If something goes wrong:**
   - `flag-kill module.feature on` turns the feature off everywhere within one request.
   - `flag-rollback module.feature` removes the rollout cohort, so orgs fall back to the default.
   - Release the kill switch with `flag-kill module.feature off` once the fix ships.

Every override change is audited (`install_audit_trail` on `app.feature_flag_overrides`).

## Deployment rollouts

The gate (`decideStage`) compares the canary deployment with current production over the same window:

- **Hold** until the canary has served 200 requests and the stage has baked: 30 minutes at 5 percent, 60 minutes at 25 percent.
- **Roll back** when:
  - the canary error rate is above 2 percent;
  - it is more than 0.5 points above baseline and more than 1.5 times baseline;
  - or the canary p95 is above 800 ms and more than 1.5 times baseline.
- **Promote** otherwise.

`pnpm --filter @xos/infra rollout:gate gate metrics.json` takes `{ currentPercent, minutesAtStage, baseline: {requests, errors, p95Ms}, canary: {...} }`. It exits 0 to promote, 3 to hold and 4 to roll back.

### Vercel settings

The team's plan includes Rolling Releases for one project, and the owner gave it to `atlas` (ADR 0033, decision 50). They are enabled there with these settings:

| Setting                              | Value                                           |
| ------------------------------------ | ----------------------------------------------- |
| Project, Settings, Rolling Releases  | Enabled for the Production environment          |
| Stages                               | 5 percent, then 25 percent, then 100 percent    |
| Advancement                          | Manual approval (the gate decides, see below)   |
| Skew protection (Settings, Advanced) | Enabled, so one session stays on one deployment |

`gateway`, `docs` and `console` have no slot. They promote directly and roll back with Instant Rollback, as described at the end of this section.

The CI job `release-gate` (see `infra/ci/README.md`) reads the canary and baseline numbers for the window. It then approves the next stage, or aborts the rolling release and rolls back to the previous production deployment. Until that job runs, the release owner reads the numbers from Vercel Observability for both deployments, runs the gate command by hand and follows its answer.

For `gateway`, which has no Rolling Release, use Vercel's Instant Rollback (included in every plan). Promote a build only after it has run on its preview URL against staging for 30 minutes with the synthetic checks green, then run the gate on the first 30 minutes of production traffic against the previous deployment's numbers. Roll back immediately when the gate says roll back. `docs` and `console` promote directly and use Instant Rollback the same way.

## Database changes

Database changes follow expand and contract, as Section 5.1 requires: add, backfill, switch, then remove in a later release. No migration in a release may break the build before it, so a deployment rollback never needs a database rollback.
