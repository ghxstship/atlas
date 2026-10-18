/**
 * Journey 57, the push half, on the iOS simulator (ADR 0030): the Demo Field Tech submits a timesheet,
 * migration 1140 asks the Demo Producer to approve it, and this script delivers that request to Compass
 * as the push the sender would (`xcrun simctl push`, Expo's APNs shape: `aps.category` and the data in
 * `body`). The Producer then approves it from the notification's Approve action, and `verify` reads the
 * timesheet back as Approved by the Producer and the request gone from the Inbox.
 *
 *   node --experimental-strip-types scripts/journey-57-push.ts prepare | verify | serve
 *
 * Needs SUPABASE_URL, SUPABASE_ANON_KEY and XOS_DEMO_PASSWORD (the demo value in
 * supabase/seeds/0010_demo_identity.sql) for a local stack only, and UDID for the simulator.
 * `prepare` leaves its ids in STATE_FILE (default in the system temporary directory) for `verify`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const url = env("SUPABASE_URL");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("Local stacks only.");
const anon = env("SUPABASE_ANON_KEY");
const stateFile = process.env["STATE_FILE"] ?? join(tmpdir(), "xos-journey-57.json");
const PROJECT = "01920000-0000-7000-8000-000000001001";
const BUNDLE = "pro.ghxstship.compass";

async function signIn(email: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: env("XOS_DEMO_PASSWORD") }),
  });
  const body = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!body.access_token || !body.user) throw new Error(`${email} could not sign in`);
  return { token: body.access_token, userId: body.user.id };
}

async function rest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Profile": "app",
      "Content-Profile": "app",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A Monday far ahead, different on every run, so the one-timesheet-per-period rule never collides. */
function freshWeek(): { start: string; end: string } {
  const base = Date.UTC(2031, 0, 6);
  const weeks = Math.floor(Date.now() / 60_000) % 500;
  const start = new Date(base + weeks * 7 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function prepare(): Promise<void> {
  const tech = await signIn("tech@example.com");
  const [person] = await rest<{ id: string }[]>(
    tech.token,
    `people?select=id&user_id=eq.${tech.userId}`,
  );
  const [membership] = await rest<{ id: string }[]>(
    tech.token,
    `memberships?select=id&person_id=eq.${person?.id ?? ""}&deleted_at=is.null`,
  );
  if (!membership) throw new Error("the Demo Field Tech has no membership");
  const week = freshWeek();
  const [sheet] = await rest<{ id: string }[]>(tech.token, "timesheets?select=id", {
    method: "POST",
    body: JSON.stringify({
      project_id: PROJECT,
      membership_id: membership.id,
      period_start: week.start,
      period_end: week.end,
    }),
  });
  if (!sheet) throw new Error("the timesheet was not created");
  await rest(tech.token, "rpc/submit_timesheet", {
    method: "POST",
    body: JSON.stringify({ p_timesheet_id: sheet.id, p_reason: "Journey 57 week." }),
  });

  const producer = await signIn("producer@example.com");
  const [note] = await rest<{ id: string; message_args: { title?: string } }[]>(
    producer.token,
    `notifications?select=id,message_args&kind=eq.approval.requested&subject_table=eq.timesheets&subject_id=eq.${sheet.id}`,
  );
  if (!note) throw new Error("migration 1140 did not ask the Producer to approve the timesheet");
  const title = note.message_args.title ?? "Timesheet";

  // What Expo's push service hands APNs for categoryId and data (expo-notifications reads data from body).
  const payload = {
    "Simulator Target Bundle": BUNDLE,
    aps: {
      alert: {
        title: "Approval requested",
        body: `Demo Field Tech asked you to approve ${title}.`,
      },
      category: "approval_request",
      sound: "default",
    },
    body: {
      notificationId: note.id,
      kind: "approval.requested",
      subjectTable: "timesheets",
      subjectId: sheet.id,
      title,
    },
  };
  const payloadFile = join(tmpdir(), "xos-journey-57.apns");
  writeFileSync(payloadFile, JSON.stringify(payload, null, 2));
  execFileSync("xcrun", ["simctl", "push", env("UDID"), BUNDLE, payloadFile], { stdio: "inherit" });
  writeFileSync(
    stateFile,
    JSON.stringify({ timesheetId: sheet.id, notificationId: note.id, title }),
  );
  console.log(`Pushed the approval request ${note.id} for timesheet ${sheet.id} (${title}).`);
}

async function verify(): Promise<void> {
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
    timesheetId: string;
    notificationId: string;
  };
  const producer = await signIn("producer@example.com");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [sheet] = await rest<{ timesheet_state: string }[]>(
      producer.token,
      `timesheets?select=timesheet_state&id=eq.${state.timesheetId}`,
    );
    const approvals = await rest<{ approved_by: string }[]>(
      producer.token,
      `timesheet_approvals?select=approved_by&timesheet_id=eq.${state.timesheetId}`,
    );
    const [note] = await rest<{ archived_at: string | null }[]>(
      producer.token,
      `notifications?select=archived_at&id=eq.${state.notificationId}`,
    );
    const [person] = await rest<{ id: string }[]>(
      producer.token,
      `people?select=id&user_id=eq.${producer.userId}`,
    );
    const done =
      sheet?.timesheet_state === "Approved" &&
      approvals.some((a) => a.approved_by === person?.id) &&
      note?.archived_at !== null;
    if (done) {
      console.log(
        JSON.stringify({
          timesheet: "Approved",
          approvedBy: "Demo Producer",
          inboxItem: "archived",
        }),
      );
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`not approved: ${JSON.stringify({ sheet, approvals, note })}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * `serve`: the same two steps over HTTP on 127.0.0.1 (PUSH_HELPER_PORT, default 57157), so the Maestro
 * flow push-approve-timesheet can deliver the push at the moment it is ready to act on the banner
 * (POST /push) and read the outcome (POST /verify). Maestro scripts cannot run simctl themselves.
 */
async function serve(): Promise<void> {
  const port = Number(process.env["PUSH_HELPER_PORT"] ?? 57157);
  createServer((req, res) => {
    const run = req.url === "/push" ? prepare : req.url === "/verify" ? verify : null;
    if (req.method !== "POST" || !run) {
      res.writeHead(404).end();
      return;
    }
    run().then(
      () => res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
      (error: unknown) =>
        res
          .writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok: false, error: String(error) })),
    );
  }).listen(port, "127.0.0.1", () => console.log(`journey 57 push helper on ${port}`));
}

const step = process.argv[2];
if (step === "prepare") await prepare();
else if (step === "verify") await verify();
else if (step === "serve") await serve();
else throw new Error("Run with prepare, verify or serve.");
