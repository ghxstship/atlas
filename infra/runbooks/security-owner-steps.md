# Security controls only the owner can switch on

The repository now holds everything it can for these controls. Each step below needs an account, a secret or a repository setting, so nobody but the owner does it. Nothing here has been done for you. Values are never pasted into tickets, logs or this file: each `gh secret set` below asks through a hidden prompt.

State read from the GitHub API on 2026-11-06, read-only:

| Control                           | State on 2026-11-06                                                           |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Repository visibility             | **Public**, though `infra/ci/README.md` recorded it as private on 2026-10-24  |
| Mail for `ghxstship.tech`         | **No MX record**, so `security@` and every other address there cannot receive |
| Weekly backup                     | Failed on its only two runs, 2026-10-26 and 2026-11-02 (below)                |
| Actions secrets in the repository | `SUPABASE_ACCESS_TOKEN` only                                                  |
| `production-backup` environment   | Exists, with no secret and **no branch rule**                                 |
| Branch protection on `main`       | None, and no ruleset                                                          |
| Private vulnerability reporting   | Off                                                                           |
| Secret scanning, push protection  | Off                                                                           |
| Dependabot alerts                 | Off                                                                           |
| CodeQL default setup              | Off, which is right now that `codeql.yml` exists                              |

## Order

**Finish step 0 before this branch deploys.** Merging to `main` deploys it, and it starts serving a mailbox that cannot receive mail. **Then merge this branch into `main`, before you run anything in steps 1 and 2 and before steps 3 and 7.** `synthetics.yml`, `post-alert.sh`, the corrected backup script and its alert, the checks step 3 requires and the workflows step 7 names exist only once it lands: run today, step 1 would run the old backup workflow and step 2's commands would fail. You can set the secrets in steps 1 and 2 before the merge, and step 1's public key goes through its own pull request.

**Right after the merge, before anything else, check that the status refs deploy nothing.** From the merge on, the scheduled checks force-push `refs/status/history` every 5 minutes, with no secret needed. Create the incident ref too, empty, from your checkout of `main`: `infra/ci/status-incidents.sh fetch status-incidents && infra/ci/status-incidents.sh publish status-incidents`. Then, after the first scheduled run (within about 10 minutes), `git ls-remote origin 'refs/status/*'` must print two lines, and [Vercel's deployment list](https://vercel.com/ghxstship/atlas/deployments) must show nothing from either ref. Both sit outside `refs/heads` because Vercel deploys every branch push on each connected project, and the one orphan branch ever pushed here (`status-site`, 2026-10-25) failed on four of them. Vercel documents deployments for branches, and these refs are not branches, but no agent could push to GitHub to see it. If a deployment does appear, turn the schedule off with `gh workflow disable synthetics.yml --repo ghxstship/atlas` and tell an agent: it would repeat every 5 minutes.

Step 1 next, the one with a legal statement waiting on it.

| Step | What                                                      | Blocks                                                         |
| ---- | --------------------------------------------------------- | -------------------------------------------------------------- |
| 0    | Mail for `ghxstship.tech`, and one test message           | **Deploying this branch**; every address in `legal/contact.md` |
|      | Merge this branch into `main`, then check Vercel at once  | The runs in steps 1 and 2; steps 3 and 7                       |
| 1    | Secret values for the backup                              | "The weekly backup has run", once one succeeds                 |
| 2    | The alert channel and the status page token               | Alerts reaching a person; the status page                      |
| 3    | Branch protection on `main`                               | "Changes reach main only through pull requests"                |
| 4    | Commit signing, after one release under step 3            | "Commits on main are signed"                                   |
| 5    | Private vulnerability reporting                           | The second disclosure channel                                  |
| 6    | Vercel staged rollout, before the first customer signs in | "Atlas rolls out in stages"                                    |
| 7    | Renovate, Dependabot alerts, secret scanning              | "Dependency update requests run"                               |
| 8    | Confirm the production values                             | Re-reading the Security Overview and DPA Annex II              |

## 0. Mail for `ghxstship.tech`

**The domain cannot receive mail today.** `dig +short MX ghxstship.tech` returned nothing on 2026-11-06, and the domain has no TXT record either. `ghxstship.pro` has Google's MX records, and the subdomains `send.mail` and `inbound` have their own, which do not help the top-level addresses. No agent sent a test message, but with no MX a sender falls back to the Vercel A records, so a report should bounce.

GitHub private reporting is off too (step 5). So after this branch deploys, `SECURITY.md` and `security.txt` send researchers to a mailbox that does not exist, while promising an answer in 3 business days and a safe harbor that depends on reporting to us. The failure is the same for every address in `legal/contact.md`: `privacy@` takes data subject requests, which carry legal deadlines, `copyright@` is the DMCA agent's address, and `legal@`, `support@`, `abuse@` and `accessibility@` are published as well.

From the merge, `SECURITY.md` tells a researcher whose mail bounces to use the issue form "Ask for a private way to report a security finding", which asks only why they need one. GitHub reads issue forms from `main`, so the form does not exist until then. That keeps one door open for security, for someone with a GitHub account, and no other address. It is not a replacement for this step.

1. **Add the domain to your Google Workspace,** the one `ghxstship.pro`'s Google MX records suggest you already have: [Admin console, Account, Domains, Manage domains](https://admin.google.com/ac/domains/manage), Add a domain, `ghxstship.tech`, as a secondary domain. Google gives you a TXT value to prove you own it. The domain uses Vercel's nameservers, so add it there:

   ```sh
   vercel dns add ghxstship.tech '@' TXT '<the value Google gives you>' --scope ghxstship
   ```

2. **Route the mail to Google:**

   ```sh
   vercel dns add ghxstship.tech '@' MX smtp.google.com 1 --scope ghxstship
   ```

   Vercel's A records for the sites stay as they are. Do not touch the records under `mail.` or `inbound.`, which belong to Resend and to reply by email.

3. **Create the addresses:** `security`, `legal`, `privacy`, `support`, `abuse`, `accessibility` and `copyright`, as groups at [Directory, Groups](https://admin.google.com/ac/groups) so that a second person can be added later. Google's groups refuse outside mail by default: set **Who can post** to "Anyone on the web" on each, or the mail bounces all the same.
4. **Say who may send for these addresses.** `p=none` blocks nothing yet, as with `mail.ghxstship.tech` (ADR 0033, decision 46): it changes no delivery, and `mail.` keeps its own policy. Leave `rua` out. It would send daily automated XML to whatever address it names, and `security@` carries a 3 business day promise that those reports would bury. Add it, to a separate address, when someone will read the reports, and tighten `p` after that:

   ```sh
   vercel dns add ghxstship.tech '@' TXT 'v=spf1 include:_spf.google.com ~all' --scope ghxstship
   vercel dns add ghxstship.tech _dmarc TXT 'v=DMARC1; p=none' --scope ghxstship
   ```

5. **Test it from outside.** Send one message from an address not on your Workspace, such as a personal account, to `security@ghxstship.tech` and to each other address. Each must arrive where you will read it. `dig +short MX ghxstship.tech` must print `1 smtp.google.com.`. Record the date, so the legal documents can rely on it.
6. **Watch the repository's issues,** at [Watch, Custom, Issues](https://github.com/ghxstship/atlas), because the form promises an answer from there. To answer one, [draft a security advisory](https://github.com/ghxstship/atlas/security/advisories/new), which works with private reporting off, add the person as a collaborator on the draft, and say so in the issue. If they put details in the issue anyway, edit them out and tell them why.

Only after the test message in item 5 above has arrived at every address should this branch deploy. **If you would rather use an address that works today,** choose one, then change `SECURITY.md`, the `Contact` line in `apps/atlas/app/.well-known/security.txt/route.ts` and `apps/gateway/app/.well-known/security.txt/route.ts`, the test in `infra/security/test/repo-controls.test.ts`, and the legal documents together. A working address at `ghxstship.pro` needs its own mailbox or group: an MX record shows the domain takes mail and says nothing about one address.

## 1. Secret values for the backup

**Root cause.** Both runs, [40329682805](https://github.com/ghxstship/atlas/actions/runs/40329682805) and [41480339205](https://github.com/ghxstship/atlas/actions/runs/41480339205), failed at "Dump and encrypt" in both jobs with `XOS_BACKUP_DB_URL is not set`. The workflow reads that from `STAGING_DB_URL` and `PRODUCTION_BACKUP_DB_URL`, and neither secret exists. Behind that error the run would have hit a second one: `infra/backup/backup-public-key.asc` is not committed. The script stopped at the first and never said so. It now names every missing piece in one run.

Nothing in the repository's dump logic caused these failures. The `--reader` dump was run against a local stack with a throwaway key on 2026-11-06 (`backup-and-restore.md`).

1. **Create the backup key on your own machine, not in CI.** Install GnuPG if you need it (`brew install gnupg`).

   ```sh
   gpg --quick-generate-key "XOS Backup <security@ghxstship.tech>" ed25519 cert 3y
   FPR=$(gpg --list-keys --with-colons "XOS Backup" | awk -F: '/^fpr:/ {print $10; exit}')
   gpg --quick-add-key "$FPR" cv25519 encr 3y
   ```

   gpg asks for a passphrase. Keep it in your password manager.

2. **Keep two offline copies of the private key.** `gpg --armor --export-secret-keys "$FPR"` writes it; save it to two separate offline places, never into the repository or a chat. Without it, every archive is unreadable, and no one can recover it for you. One person holding the only copy is a single point of failure, so decide who else can reach the second copy.

3. **Commit the public key** through a pull request. It holds nothing secret:

   ```sh
   mkdir -p infra/backup && gpg --armor --export "$FPR" > infra/backup/backup-public-key.asc
   ```

4. **Give the production login a password.** Follow `backup-and-restore.md`, Set up the production backup login, steps 1 to 3. Use letters and digits only, so the connection string needs no escaping.

5. **Restrict the environment to `main`.** It has no branch rule today, so any branch could read the secret you are about to add. In [Settings, Environments, production-backup](https://github.com/ghxstship/atlas/settings/environments), under Deployment branches and tags, choose Selected branches and tags and add `main`. Or:

   ```sh
   gh api --method PUT repos/ghxstship/atlas/environments/production-backup \
     --input - <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
   gh api --method POST repos/ghxstship/atlas/environments/production-backup/deployment-branch-policies \
     -f name=main -f type=branch
   ```

6. **Add the secret.** With no `--body`, `gh` asks for the value without echoing it:

   ```sh
   gh secret set PRODUCTION_BACKUP_DB_URL --env production-backup --repo ghxstship/atlas
   ```

7. **Staging is optional.** Its job skips with a notice until `STAGING_DB_URL` exists, because staging holds no customer data. If you want it, run `gh secret set STAGING_DB_URL --repo ghxstship/atlas` with the staging branch's Session pooler string. That string logs in as `postgres`, which is more than a backup needs, so skipping it is the smaller risk.

8. **Run it once and read it back:**

   ```sh
   gh workflow run backup-weekly.yml --repo ghxstship/atlas --ref main
   # Give GitHub a few seconds to list the new run, then:
   RUN=$(gh run list --repo ghxstship/atlas --workflow backup-weekly.yml --limit 1 --json databaseId -q '.[0].databaseId')
   gh run watch --repo ghxstship/atlas "$RUN"
   gh run download "$RUN" --repo ghxstship/atlas --name xos-production-backup --dir /tmp/xos-backup-check
   gpg --decrypt /tmp/xos-backup-check/*.gpg | tar -tzf -
   ```

   The list must show `roles.sql schema.sql data.sql platform.sql cron.sql migrations.txt`. Delete the check folder afterwards: `data.sql` is production personal data once decrypted. Then record the date, because the Security Overview's "has not yet completed a run" can change only after this.

**Exposure to accept knowingly.** On a public repository anyone signed in to GitHub can download a workflow artifact and read the run's summary. The archive is encrypted to your key and the connection string is masked, so what is public is the file's size, name and hash, and how often it runs. The artifacts expire after 35 days, the repository's maximum being 90. A person's deletion does not reach an archive already made, which ages out on that schedule.

## 2. The alert channel and the status page token

Without the webhook, an alert is only a failed run, and GitHub emails that to just one person: whoever last changed the workflow's schedule.

1. Create a Slack incoming webhook for the on-call channel ([Slack's steps](https://api.slack.com/messaging/webhooks)). Any endpoint that takes `{"text": "..."}` works.
2. `gh secret set XOS_ALERT_WEBHOOK_URL --repo ghxstship/atlas`
3. In [Vercel, Account Settings, Tokens](https://vercel.com/account/tokens), create a token limited to the team, then `gh secret set VERCEL_STATUS_TOKEN --repo ghxstship/atlas`. The variables `VERCEL_ORG_ID` and `VERCEL_STATUS_PROJECT_ID` are already set.
4. Run it once: `gh workflow run synthetics.yml --repo ghxstship/atlas --ref main`. Open the run. All five checks should pass, `git ls-remote origin refs/status/history` should print one line, and `status.ghxstship.tech` should show a new "Last checked" on Atlas, Gateway, the API and Documentation and "Not checked yet" on the other three. No agent requested the public hosts while building this, so this first run is the first real test of the expected answers (a 401 problem document from `api.ghxstship.tech/v1/canon/departments`, a 200 from `docs.ghxstship.tech/en-US`). A check that fails here is more likely a wrong expectation than an outage.

   The `atlas` project's [deployment list](https://vercel.com/ghxstship/atlas/deployments) must still show nothing new from this run, as in the check right after the merge (Order); only the `status` project deploys. The branch `status-site` serves no purpose now and is yours to delete if you wish.

5. To test the path to the channel without an outage, send it one line. `read -rs` takes the address without echoing it or saving it in your shell history:

   ```sh
   read -rs XOS_ALERT_WEBHOOK_URL && export XOS_ALERT_WEBHOOK_URL
   infra/ci/post-alert.sh "Test of the XOS alert channel"
   unset XOS_ALERT_WEBHOOK_URL
   ```

A required check that fails twice in a row posts once, again every 6 hours, and once when it recovers. Only those runs are marked failed. The status page follows the same line, so it says Outage and "We are working on it" only for a failure that has alerted, and it redeploys only when a failure is confirmed or ends, and about once an hour. GitHub can delay or drop a scheduled run, so "about" is the honest word.

A single failed check or a slow answer never alerts and never deploys. If the hourly deployment happens to catch one, the row shows Degraded until the next update. In the daily history and the 30-day uptime figure, only confirmed failures, both of the pair and every failure after them, count against the service. A day shows Outage when those leave under 99 percent of its checks good, about 20 minutes on a component with one check, and Degraded on any shorter one. Scattered single failures and slow answers mark a day Degraded only when together they pass 5 percent of its answers. SLA Section 2 must define Downtime the same way (RRR-248). **After the first day, read the `ms` column in a few run summaries.** The budgets in `infra/synthetics/src/checks.ts` (600 ms for the sign-in pages, the API document and the API host, 800 ms for docs) have never been measured from a GitHub runner, and a budget that is too tight is a false public statement. If they are, raise them there.

**What this does not measure.** These checks see the sign-in page and not a sign-in, and the API's document and refusal and not an API read. SLA Section 2 defines Downtime by "sign-in or an API read", so that wording has to change with this (RRR-248). A signed-in check needs a synthetic account in production holding no real data. Better Stack's monitors could do it too, which is a separate decision (ADR 0033, decision 45).

## 3. Branch protection on `main`

Apply this after this branch has merged, since it requires checks that exist from then on.

`infra/security/github/main-ruleset.json` is the rule, and a unit test keeps its check names true:

- every change reaches `main` through a pull request, merged only with a merge commit;
- `CI required checks`, which fails unless every CI job passed, plus `Analyze (javascript-typescript)` and `Analyze (python)`, must pass;
- no force push, no deletion, and nobody on the bypass list.

**Requiring one CI check is deliberate.** A CI run reports about 40 check names today, and they change whenever a matrix changes. `CI required checks` needs every job, so the setting never has to change. A unit test fails when a new job is left out of it. `Supabase advisors on staging` runs only on a push to `main`, so it is not in the list; a check that never reports on a pull request would block every merge.

**Zero approving reviews is deliberate too,** and it is a limit you should know about. GitHub does not let an author approve their own pull request, and you are the only collaborator, so requiring one approval would stop every release. The Security Overview and the change policy describe approval by a second maintainer as not enforced, and that stays true until a second person exists; then set `required_approving_review_count` to 1.

**The up-to-date requirement is off,** so merging a train into `batch-c` does not restart a 2.5-hour CI run on every open release.

Apply it:

```sh
gh api --method POST repos/ghxstship/atlas/rulesets --input infra/security/github/main-ruleset.json
```

Or read it first at [Settings, Rules, Rulesets](https://github.com/ghxstship/atlas/settings/rules), then check it with `gh api repos/ghxstship/atlas/rules/branches/main`. Rulesets are free on a public repository. On a private one, they need a paid plan.

### How releases must change

Releases today move `main` with a direct fast-forward push of the release commit (`docs/release-checklist.md`, "`main` fast-forwarded to..."), and the ruleset refuses that push. Everything else in `production.md`, Deploy order, stays: the drill, staging then production migrations, Edge Functions, the tag.

| Step  | Today                                   | With the ruleset                                                                 |
| ----- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Start | Train merges into `batch-c`             | The same                                                                         |
| Gate  | CI ran on the train's pull request      | Open the release pull request **first** and wait for its required checks         |
| Move  | `git push origin <release sha>:main`    | `gh pr merge <n> --merge`, after the migrations and functions                    |
| Tag   | On a second pull request's merge        | On the merge commit of the same pull request, if versions travel with it (below) |
| After | `batch-c` and `main` at the same commit | Merge `main` back into `batch-c`, since the merge commit is new                  |

```sh
# Every commit that reaches main names its issue (ADR 0015). Put the release's own issue where RRR-n stands.
TRAILERS=$(printf 'Part of RRR-n\n\nSigned-off-by: Julian Clarkson <julian.clarkson@ghxstship.pro>')

# Versions and the planned release record go on this branch, so one CI run covers them.
git fetch origin
git switch -c release-X.Y origin/batch-c
git merge --no-ff origin/main -m "merge: main into release X.Y.0" -m "$TRAILERS"   # only when main has commits batch-c lacks
# bump the package versions, add the release record, commit
git push -u origin release-X.Y
gh pr create --base main --head release-X.Y --title "chore(release): X.Y.0"
gh pr checks release-X.Y --required --watch   # about 2.5 hours of real checks, not a window to skip

# Drill, staging, production migrations and Edge Functions from this commit (production.md, Deploy order).

# Vercel deploys main; this replaces the push. GitHub's default message would drop the trailers.
gh pr merge release-X.Y --merge --subject "merge: release X.Y.0 into main" --body "$TRAILERS"
git switch main && git pull --ff-only
git tag -m "vX.Y.0" vX.Y.0 && git push origin vX.Y.0   # a tag is not a branch, so the ruleset does not touch it
git fetch origin && git switch batch-c
git merge --no-ff origin/main -m "merge: main, with the release X.Y.0 merge, into batch-c" -m "$TRAILERS"
git push
```

**Incidents do not go through `main`.** The status page reads its incident list from `refs/status/incidents`, which this ruleset does not cover, so posting or updating an incident takes minutes and deploys nothing but the status page (`incident-response.md`, Communication). Do not move the list back into a file on `main`: a pull request's required checks take over an hour, the runbook requires a post within 30 minutes, and every merge would deploy production during a deploy freeze.

The deployed commit is now a merge commit with the same tree as the release commit, so record that commit in the release record. Evidence gathered after the deploy goes in with the next train; a pull request only for the record would run the full CI again. Anything that automates a release, including the orchestrator's own notes, must stop pushing to `main`. A pull request that adds a job must add it to the `required` job's `needs`.

**In an emergency,** a bad deploy does not need `main` at all: Vercel Instant Rollback and the kill switches work as before (`incident-response.md`). If only a commit on `main` will do and CI cannot wait, turn the rule off, push, turn it back on, and write it in the incident timeline. GitHub's audit log records both changes:

```sh
ID=$(gh api repos/ghxstship/atlas/rulesets -q '.[] | select(.name == "main") | .id')
gh api --method PUT "repos/ghxstship/atlas/rulesets/$ID" -f enforcement=disabled
# fix, push, verify
gh api --method PUT "repos/ghxstship/atlas/rulesets/$ID" -f enforcement=active
```

Once CodeQL has run and you have triaged its first alerts, add the rule that blocks new high ones, as step 4 adds its rule: `{"type":"code_scanning","parameters":{"code_scanning_tools":[{"tool":"CodeQL","alerts_threshold":"errors","security_alerts_threshold":"high_or_higher"}]}}`. Not before: it would stop a release over findings that are already there.

## 4. Commit signing

**Do this after one release under step 3, not with it.** GitHub checks every commit a pull request brings, and [its documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) warns that unsigned commits on the head branch can block even a squash merge. No commit on `main` is signed today, and `batch-c` holds many more that are not. Turned on now, the rule would stop the next release. Squashing around it would lose each commit's trailer and leave `main` and `batch-c` with unrelated histories.

1. **Start signing, on the machine that makes the commits.** Agents commit from the same user account, so they pick this up:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/xos_signing -C "julian.clarkson@ghxstship.pro"
   ssh-add --apple-use-keychain ~/.ssh/xos_signing
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/xos_signing.pub
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true
   ```

2. **Add `~/.ssh/xos_signing.pub` to GitHub as a Signing Key,** at [Settings, SSH and GPG keys, New SSH key](https://github.com/settings/ssh/new), key type "Signing Key". Commit under an email address verified on that account. Check one commit on a scratch branch shows Verified.
3. **Mind the merge-train tools.** A history rewrite drops signatures. After `filter-branch`, or a renumbering that rewrites commits, re-sign the branch with `git rebase --exec 'git commit --amend --no-edit -S' <base>`.
4. **Let one release carry the unsigned history to `main`,** with the rule still off.
5. **Check what is left, then turn it on.** The first command must print nothing:

   ```sh
   gh api repos/ghxstship/atlas/compare/main...batch-c --paginate \
     -q '.commits[] | select(.commit.verification.verified == false) | .sha'
   ID=$(gh api repos/ghxstship/atlas/rulesets -q '.[] | select(.name == "main") | .id')
   jq '.rules += [{"type":"required_signatures"}]' infra/security/github/main-ruleset.json |
     gh api --method PUT "repos/ghxstship/atlas/rulesets/$ID" --input -
   ```

   Then add the same rule to `infra/security/github/main-ruleset.json` through a pull request, so the file stays the record. A merge made through GitHub is signed by GitHub, which is why the ruleset allows only merge commits: its rebase merge recreates commits it cannot sign. Renovate's commits go through GitHub's API for the same reason (`platformCommit` in `renovate.json`).

The `Signed-off-by` trailer is a different thing, the DCO. No check enforces it, and `CONTRIBUTING.md` now says so. The [DCO app](https://github.com/apps/dco) would add one if you want it.

## 5. Private vulnerability reporting

Email to `security@ghxstship.tech` is the named channel (`SECURITY.md`), and it works only after step 0. GitHub's channel is a second door, not a replacement, because a researcher without an account still needs the email. GitHub documents this feature for public repositories, so it also depends on the visibility decision in section 8.

Turn it on at [Settings, Code security, Private vulnerability reporting](https://github.com/ghxstship/atlas/settings/security_analysis), or:

```sh
gh api --method PUT repos/ghxstship/atlas/private-vulnerability-reporting
```

Check with `gh api repos/ghxstship/atlas/private-vulnerability-reporting`, which answers `{"enabled":true}`. `SECURITY.md` is written to stay true either way. Reports then also arrive in GitHub's notifications, so check those count toward the 3 business day acknowledgment.

## 6. Vercel staged rollout

You paused this on 2026-10-25 until production has its first customer org, because with no traffic to split a canary only costs credits (`progressive-delivery.md`). That still holds. Turn it on **before the first customer signs in**; the legal documents say it is off until then. The plan allows it on one project, and `atlas` has that slot (ADR 0033, decision 50).

1. In [Vercel, `atlas`, Settings, Build & Deployment](https://vercel.com/ghxstship/atlas/settings/build-and-deployment), scroll to Rolling Releases and enable it for Production.
2. Set the stages to 5, 25 and 100 percent, each advanced by manual approval (`infra/delivery/rollout.json`).
3. In [Settings, Advanced](https://vercel.com/ghxstship/atlas/settings/advanced), turn on Skew Protection. Vercel [recommends it strongly](https://vercel.com/docs/rolling-releases): without it, a person can load one deployment's page and call the other's server.

Once on, merging to `main` starts a rollout at 5 percent, and no other release can start until it completes or aborts. Between stages, run the gate by hand (`pnpm --filter @xos/infra rollout:gate gate metrics.json`, `progressive-delivery.md`): the CI job `release-gate` that document mentions does not exist, so a person reads the numbers. The Security Overview already says the gate does not act by itself.

## 7. Renovate, Dependabot alerts and secret scanning

1. Install the [Renovate GitHub App](https://github.com/apps/renovate) on `ghxstship/atlas` only. `renovate.json` is committed, so it runs from its first scan: a weekly batch, nothing younger than two weeks, overrides only when you ask from its dashboard, never an automatic merge.
2. Turn on Dependabot alerts, which Renovate reads to open a security pull request at once: `gh api --method PUT repos/ghxstship/atlas/vulnerability-alerts`. A release younger than two weeks still needs your security exception, recorded in ADR 0001.
3. Turn on secret scanning and push protection, free on a public repository:

   ```sh
   gh api --method PATCH repos/ghxstship/atlas --input - <<< \
     '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'
   ```

4. Leave CodeQL's default setup off. GitHub refuses `codeql.yml`'s uploads while it is on, and ADR 0033's decision 15 is met by the workflow (ADR 0001, amendment of 2026-11-06).
5. For the ZAP baseline, add `VERCEL_AUTOMATION_BYPASS_SECRET` (`infra/security/README.md`, Owner steps). It has never run a scan without that: the nightly job passes with a notice.

## 8. Production values only you can confirm

An agent checked each of these against the code on 2026-11-06. Each is a value in a dashboard the agent did not open. The right-hand column is what the code needs.

| Setting                  | Where                                                                                                       | What the code needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository visibility    | [Settings, General](https://github.com/ghxstship/atlas/settings)                                            | You decided private on 2026-10-24, and it reads public. Decide which. Private means paid plans for rulesets, environments and CodeQL, and `synthetics.yml` every 15 minutes. It also breaks four things that rely on a public repository: `SECURITY.md` and the `Policy` link in `security.txt` stop resolving for researchers, so point `Policy` at the published `/legal` page first; the issue fallback in `SECURITY.md` closes, so step 0's mail becomes the only way in and that sentence must go; private vulnerability reporting (step 5) is documented for public repositories, so plan on losing it; and the runbook links in alert lines stop resolving for anyone without access. Public means npm provenance could come back |
| Alert webhook            | `XOS_ALERT_WEBHOOK_URL`, a repository secret                                                                | Not set. It takes `{"text": "..."}`, which a Slack incoming webhook accepts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Log drains               | Vercel, Team Settings, Drains; Supabase, Project Settings, Log Drains                                       | Each to a Better Stack source (decision 45). The Security Overview says the Supabase one is not set up yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Log drain transform      | Better Stack, each source, Transformations                                                                  | **Replace it** with the VRL now in `production.md`. The approved version does not mask `/share/view/`, `/share/screen/`, `/auth/act/` or the `xact`, `xlch`, `xlgr`, `xscr` and `xshv` prefixes, so those tokens reach the log store. If any drain is live, treat the tokens it stored as exposed                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Better Stack monitors    | Better Stack, Uptime                                                                                        | One-minute checks from five regions (decision 45). The Security Overview says one monitor runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Scanner host and port    | `supabase secrets list --project-ref <production-ref>`, names only                                          | `XOS_CLAMAV_HOST=xos-clamav.fly.dev`, `XOS_CLAMAV_PORT=3311`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Scanner TLS              | The same list                                                                                               | `XOS_CLAMAV_TLS_CA`, `XOS_CLAMAV_TLS_CERT`, `XOS_CLAMAV_TLS_KEY`: all three or none. With some of them, the function refuses to start scanning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Scanner running          | `fly status --app xos-clamav`                                                                               | One machine started. Calling `upload-scan` once with the service key answers 200 and `"scanner": "clamav"`, not a 503                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Scanner schedule         | `select jobname from cron.job where command like '%upload-scan%';`                                          | `upload-scan` every minute. No migration schedules it, so it was set by hand or not at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `XOS_ENVIRONMENT`        | The same secrets list                                                                                       | `production`, so the function never falls back to the development pass-through                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sentry DSNs and projects | Vercel and Supabase secrets; Sentry                                                                         | `SENTRY_DSN` set. `production.md` names the projects `xos-atlas` and `xos-gateway`, `incident-response.md` names them `atlas` and `gateway`, and no code names either: tell us which is right                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `xos_backup` password    | Set by you in step 1                                                                                        | The login cannot sign in until you set one (migration 1650)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Point-in-time recovery   | [Supabase, Database, Backups](https://supabase.com/dashboard/project/fquuqnzlpobaawucczgq/database/backups) | The 1 hour recovery point depends on it (`backup-and-restore.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Security mailbox         | `security@ghxstship.tech`                                                                                   | **Cannot receive mail: no MX record on 2026-11-06.** Step 0. `security.txt` and `SECURITY.md` send reports there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
