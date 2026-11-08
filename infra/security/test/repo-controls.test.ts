import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The controls the repository holds for itself (infra/runbooks/security-owner-steps.md). Each test fails when a
 * change would quietly make a stated control untrue.
 */
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repo, path), "utf8");

/** The two-space-indented job ids of a workflow. */
function jobIds(workflow: string): string[] {
  const body = workflow.slice(workflow.indexOf("\njobs:\n"));
  return [...body.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((match) => match[1] ?? "");
}

describe("the main ruleset's required checks", () => {
  const ci = read(".github/workflows/ci.yml");
  const ruleset = JSON.parse(read("infra/security/github/main-ruleset.json")) as {
    bypass_actors: unknown[];
    rules: Array<{
      type: string;
      parameters?: {
        allowed_merge_methods?: string[];
        required_status_checks?: Array<{ context: string }>;
      };
    }>;
  };

  it("makes every job of CI a need of the one required job", () => {
    const required = ci.slice(ci.indexOf("\n  required:\n"));
    const needs = [...required.matchAll(/^ {6}- ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    // Runs only on a push to main, so it can never pass on a pull request.
    const expected = jobIds(ci).filter(
      (id) => id !== "required" && id !== "supabase-advisors-staging",
    );
    expect(
      needs.toSorted(),
      "A job in ci.yml is missing from needs of the `required` job, so main would merge without it.",
    ).toEqual(expected.toSorted());
    expect(required).toContain("if: always()");
  });

  it("requires only names the workflows report", () => {
    const contexts = ruleset.rules
      .find((rule) => rule.type === "required_status_checks")
      ?.parameters?.required_status_checks?.map((check) => check.context);
    expect(contexts).toEqual([
      "CI required checks",
      "Analyze (javascript-typescript)",
      "Analyze (python)",
    ]);
    expect(ci).toContain("name: CI required checks");
    const codeql = read(".github/workflows/codeql.yml");
    expect(codeql).toContain("name: Analyze (${{ matrix.language }})");
    expect(codeql).toContain("language: [javascript-typescript, python]");
    expect(codeql).not.toMatch(/paths(-ignore)?:/);
  });

  it("keeps a release's commits and gives nobody a way around the rules", () => {
    expect(ruleset.bypass_actors).toEqual([]);
    const pullRequest = ruleset.rules.find((rule) => rule.type === "pull_request");
    expect(pullRequest?.parameters?.allowed_merge_methods).toEqual(["merge"]);
    expect(ruleset.rules.map((rule) => rule.type)).toEqual(
      expect.arrayContaining(["deletion", "non_fast_forward"]),
    );
  });
});

describe("the synthetics workflow", () => {
  const workflow = read(".github/workflows/synthetics.yml");

  it("runs on a schedule with no credential and no staging target", () => {
    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).not.toMatch(/SYNTHETIC_(EMAIL|PASSWORD)|SUPABASE_|staging/i);
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
    expect(new Set(secrets)).toEqual(new Set(["XOS_ALERT_WEBHOOK_URL", "VERCEL_STATUS_TOKEN"]));
  });

  it("publishes the history even when a run fails, since a streak needs it", () => {
    expect(workflow).toContain("if: always() && steps.run.outcome != 'skipped'");
    expect(workflow).toContain("infra/ci/status-history.sh publish");
  });
});

describe("the weekly backup", () => {
  const workflow = read(".github/workflows/backup-weekly.yml");

  it("alerts the channel when a job fails", () => {
    expect(jobIds(workflow)).toEqual(["staging", "production", "alert"]);
    const alert = workflow.slice(workflow.indexOf("\n  alert:\n"));
    expect(alert).toContain("needs: [staging, production]");
    expect(alert).toContain("if: failure()");
    expect(alert).toContain("infra/ci/post-alert.sh");
  });

  it("keeps the production job required and read-only", () => {
    const production = workflow.slice(
      workflow.indexOf("\n  production:\n"),
      workflow.indexOf("\n  alert:\n"),
    );
    expect(production).toContain("environment: production-backup");
    expect(production).toContain("--reader");
    expect(production).not.toContain("steps.gate");
  });

  it("stores no backup on GitHub, only in the private bucket the secrets name", () => {
    const steps = workflow.replace(/^\s*#.*$/gm, "");
    for (const store of ["upload-artifact", "actions/cache", "gh release", "git push", "gh gist"]) {
      expect(steps).not.toContain(store);
    }
    const storage = [
      "BACKUP_ENCRYPTION_RECIPIENT",
      "BACKUP_S3_ENDPOINT",
      "BACKUP_S3_REGION",
      "BACKUP_S3_BUCKET",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
    ];
    for (const [job, next] of [
      ["staging", "production"],
      ["production", "alert"],
    ] as const) {
      const section = workflow.slice(
        workflow.indexOf(`\n  ${job}:\n`),
        workflow.indexOf(`\n  ${next}:\n`),
      );
      expect(section).toContain("environment: production-backup");
      for (const name of storage) {
        expect(section).toContain(`${name}: \${{ secrets.${name} }}`);
      }
    }
  });

  it("refuses to store without every bucket setting, and never prints one", () => {
    const store = join(repo, "infra/ci/backup-store.sh");
    const missing = spawnSync("bash", [store, "check"], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] },
    });
    expect(missing.status).toBe(1);
    for (const name of [
      "BACKUP_S3_ENDPOINT",
      "BACKUP_S3_REGION",
      "BACKUP_S3_BUCKET",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(missing.stderr).toContain(`The secret ${name} is empty`);
    }
    const values = {
      BACKUP_S3_ENDPOINT: "http://storage.not-a-real-host.test",
      BACKUP_S3_REGION: "region-not-a-real-value",
      BACKUP_S3_BUCKET: "Bucket_Not_A_Real_Value",
      BACKUP_S3_ACCESS_KEY_ID: "key-not-a-real-value",
      BACKUP_S3_SECRET_ACCESS_KEY: "secret-not-a-real-value",
    };
    const wrong = spawnSync("bash", [store, "put", "/nonexistent", "production"], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], ...values },
    });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("BACKUP_S3_ENDPOINT is not an https:// address");
    expect(wrong.stderr).toContain("BACKUP_S3_BUCKET is not a bucket name");
    for (const value of Object.values(values)) {
      expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(value);
    }
  });

  it("names every missing piece at once, and never prints the connection string", () => {
    const cwd = mkdtempSync(join(tmpdir(), "xos-backup-"));
    try {
      const run = spawnSync(
        "bash",
        [join(repo, "infra/ci/backup-weekly.sh"), "production", "out", "--reader"],
        {
          cwd,
          encoding: "utf8",
          env: { PATH: process.env["PATH"], XOS_BACKUP_SECRET_NAME: "PRODUCTION_BACKUP_DB_URL" },
        },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("set the secret PRODUCTION_BACKUP_DB_URL");
      expect(run.stderr).toContain("infra/backup/backup-public-key.asc is missing");
      const secretValue = "postgres://xos_backup:not-a-real-value@db.test:5432/postgres";
      const withUrl = spawnSync(
        "bash",
        [join(repo, "infra/ci/backup-weekly.sh"), "staging", "out"],
        {
          cwd,
          encoding: "utf8",
          env: { PATH: process.env["PATH"], XOS_BACKUP_DB_URL: secretValue },
        },
      );
      expect(withUrl.status).toBe(1);
      expect(withUrl.stderr).not.toContain("connection string is empty");
      expect(`${withUrl.stdout}${withUrl.stderr}`).not.toContain("not-a-real-value");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("the CI scripts", () => {
  const history = join(repo, "infra/ci/status-history.sh");

  it("keeps the status history on one commit, and tells a first run from a broken remote", () => {
    const dir = mkdtempSync(join(tmpdir(), "xos-history-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    try {
      const remote = join(dir, "remote.git");
      git(dir, "init", "--quiet", "--bare", remote);
      const work = join(dir, "work");
      git(dir, "clone", "--quiet", remote, work);
      const data = join(dir, "data");
      const run = (...args: string[]) =>
        spawnSync("bash", [history, ...args], { cwd: work, encoding: "utf8" });

      const first = run("fetch", data);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("this run starts the history");

      writeFileSync(join(data, "history.json"), '{"run":1}\n');
      expect(run("publish", data).status).toBe(0);
      writeFileSync(join(data, "history.json"), '{"run":2}\n');
      expect(run("publish", data).status).toBe(0);
      expect(git(remote, "rev-list", "--count", "refs/status/history")).toBe("1");
      // Vercel deploys every branch push on every connected project, so the history is never a branch.
      expect(git(remote, "for-each-ref", "refs/heads")).toBe("");

      rmSync(join(data, "history.json"));
      expect(run("fetch", data).status).toBe(0);
      expect(readFileSync(join(data, "history.json"), "utf8")).toBe('{"run":2}\n');

      git(work, "remote", "set-url", "origin", join(dir, "nowhere.git"));
      expect(run("fetch", data).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps incidents on their own ref, refuses a bad list and never overwrites someone else's", () => {
    const script = join(repo, "infra/ci/status-incidents.sh");
    const dir = mkdtempSync(join(tmpdir(), "xos-incidents-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    const entry = (id: string) => ({
      id,
      components: ["api"],
      regions: ["us-east"],
      startedAt: "2026-11-07T10:00:00Z",
      resolvedAt: null,
      text: {
        "en-US": { title: "API errors", update: "Investigating." },
        "es-US": { title: "Errores de la API", update: "En investigación." },
      },
    });
    try {
      const remote = join(dir, "remote.git");
      git(dir, "init", "--quiet", "--bare", remote);
      const one = join(dir, "one");
      const two = join(dir, "two");
      git(dir, "clone", "--quiet", remote, one);
      git(dir, "clone", "--quiet", remote, two);
      const run = (cwd: string, ...args: string[]) =>
        spawnSync("bash", [script, ...args], { cwd, encoding: "utf8" });
      const list = (cwd: string) => join(cwd, "status-incidents", "incidents.json");

      expect(run(one, "publish", "status-incidents").status).not.toBe(0);
      const first = run(one, "fetch", "status-incidents");
      expect(first.status).toBe(0);
      expect(readFileSync(list(one), "utf8")).toBe("[]\n");
      expect(run(two, "fetch", "status-incidents").status).toBe(0);

      writeFileSync(list(one), JSON.stringify([{ ...entry("a"), startedAt: "soon" }]));
      const refused = run(one, "publish", "status-incidents");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("incident 1 needs startedAt as an ISO time.");
      expect(git(remote, "for-each-ref", "refs/status")).toBe("");

      writeFileSync(list(one), JSON.stringify([entry("a")]));
      expect(run(one, "publish", "status-incidents").status).toBe(0);
      // Two in a row from the same fetch: the second builds on the first.
      writeFileSync(list(one), JSON.stringify([entry("a"), entry("b")]));
      expect(run(one, "publish", "status-incidents").status).toBe(0);
      expect(git(remote, "rev-list", "--count", "refs/status/incidents")).toBe("1");
      expect(git(remote, "for-each-ref", "refs/heads")).toBe("");

      // The second person fetched before either publish, so theirs would erase both entries.
      writeFileSync(list(two), JSON.stringify([entry("c")]));
      const stale = run(two, "publish", "status-incidents");
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("Run fetch again");
      expect(run(two, "fetch", "status-incidents").status).toBe(0);
      expect(JSON.parse(readFileSync(list(two), "utf8"))).toEqual([entry("a"), entry("b")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes with a warning when there is no alert channel yet", () => {
    const run = spawnSync("bash", [join(repo, "infra/ci/post-alert.sh"), "text"], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("XOS_ALERT_WEBHOOK_URL is not set");
  });
});

describe("the dependency policy", () => {
  const renovate = JSON.parse(read("renovate.json")) as {
    minimumReleaseAge: string;
    lockFileMaintenance: { enabled: boolean };
    automerge: boolean;
    packageRules: Array<{
      matchDepTypes?: string[];
      matchPackageNames?: string[];
      allowedVersions?: string;
      dependencyDashboardApproval?: boolean;
    }>;
  };

  it("waits two weeks, and never moves an override or merges by itself", () => {
    expect(renovate.minimumReleaseAge).toBe("14 days");
    expect(renovate.automerge).toBe(false);
    expect(renovate.lockFileMaintenance.enabled).toBe(false);
    const overrides = renovate.packageRules.find((rule) =>
      rule.matchDepTypes?.includes("pnpm-workspace.overrides"),
    );
    expect(overrides?.dependencyDashboardApproval).toBe(true);
  });

  it("keeps ADR 0001's holds", () => {
    const hold = (name: string) =>
      renovate.packageRules.find((rule) => rule.matchPackageNames?.includes(name));
    expect(hold("typescript")?.allowedVersions).toBe("<6.1.0");
    expect(hold("stylelint")?.allowedVersions).toBe("<17.0.0");
    expect(hold("pnpm")?.dependencyDashboardApproval).toBe(true);
    expect(hold("react-native")?.dependencyDashboardApproval).toBe(true);
  });

  it("keeps overrides in pnpm-workspace.yaml, where pnpm reads them", () => {
    const root = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(root).not.toHaveProperty("pnpm");
    expect(read("pnpm-workspace.yaml")).toMatch(/^overrides:$/m);
  });
});

describe("the disclosure contact", () => {
  const route = (app: string) => read(`apps/${app}/app/.well-known/security.txt/route.ts`);
  const text = (source: string) =>
    /`([^`]*)`/.exec(source.slice(source.indexOf("SECURITY_TXT")))?.[1] ?? "";

  it("serves the same file from Atlas and Gateway", () => {
    expect(text(route("gateway"))).toBe(text(route("atlas")));
  });

  it("meets RFC 9116 and has not expired", () => {
    const body = text(route("atlas"));
    expect(body).toMatch(/^Contact: mailto:security@ghxstship\.tech$/m);
    const expires = /^Expires: (.+)$/m.exec(body)?.[1] ?? "";
    expect(
      Date.parse(expires),
      "Renew Expires in security.txt, less than a year ahead.",
    ).toBeGreaterThan(Date.now());
    expect(read("SECURITY.md")).toContain("support@ghxstship.pro");
  });

  describe("the way in if the mailbox fails", () => {
    const templates = ".github/ISSUE_TEMPLATE";
    const form = read(`${templates}/security_private_channel.yml`);
    const chooser = read(`${templates}/config.yml`);
    const formName = /^name: (.+)$/m.exec(form)?.[1] ?? "";

    it("is a form the policy links to by name and by file", () => {
      expect(formName).not.toBe("");
      const policy = read("SECURITY.md");
      expect(policy).toContain("If your email bounces");
      expect(policy).toContain(
        `[${formName}](https://github.com/ghxstship/atlas/issues/new?template=security_private_channel.yml)`,
      );
      expect(policy).toContain("Add no details of the finding");
    });

    it("asks for no details of a finding, and warns against giving them", () => {
      expect(form).toContain("This issue is public. Do not describe the finding here");
      const fields = [...form.matchAll(/^ {2}- type: (\w+)$/gm)].map((match) => match[1]);
      expect(fields).toEqual(["markdown", "dropdown", "checkboxes"]);
    });

    it("is not contradicted by the issue chooser", () => {
      expect(chooser).toMatch(/^blank_issues_enabled: false$/m);
      const link = /^ {4}url: (.+)$/m.exec(chooser)?.[1];
      expect(link).toBe("https://github.com/ghxstship/atlas/security/policy");
      const about = /^ {4}about: (.+)$/m.exec(chooser)?.[1] ?? "";
      expect(about).toContain("support@ghxstship.pro");
      expect(about).toContain("use the form on this page");
      expect(about).not.toMatch(/never in a public issue/i);
    });
  });
});
