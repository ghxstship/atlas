import {
  RecordingPushClient,
  RecordingWebPushClient,
  dispatchPush,
  pushStore,
  webPushStore,
  type PlatformDb,
} from "@xos/platform";
import { expect as baseExpect, test } from "./engine-test";
import { publishCrewOpportunity } from "./fixtures";
import { DEMO, expectAccessible, signIn, sql, uniqueId } from "./support";

/**
 * A101 (RRR-147), trace rows S4.3-15 and S4.4-20: a marketplace alert reaches the crew person's own devices. The
 * crew person holds no membership, so nothing was registered for them before 1670 and the push was suppressed as
 * having no device. Their Gateway browser and their Compass device now register as their own, the push sender
 * records a ticket for each with the fake transports, and the browser push opens the listing it names.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * PlatformDb over the fixtures' postgres connection, so the push worker runs here as it does in its Edge Function.
 * Tickets go to jsonb parameters as JSON, as supabase-js sends them; node-postgres would send an array literal.
 */
const platformDb: PlatformDb = {
  async rpc(fn, args) {
    const names = Object.keys(args);
    const rows = await sql<Record<string, unknown>>(
      `select * from app.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`,
      names.map((n) => {
        const value = args[n];
        return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
      }),
    );
    const [first] = rows;
    return rows.length === 1 && first && Object.keys(first).join() === fn ? first[fn] : rows;
  },
  async selectOne(table, columns, match) {
    const keys = Object.keys(match);
    const [row] = await sql<Record<string, unknown>>(
      `select ${columns} from app.${table} where ${keys.map((k, i) => `${k} = $${i + 1}`).join(" and ")} limit 1`,
      keys.map((k) => match[k]),
    );
    return row ?? null;
  },
};

test("A101: a marketplace alert pushes the crew person's own browser and Compass device", async ({
  page,
}) => {
  const run = uniqueId();
  const endpoint = `https://push.example.test/send/gateway-crew-${run}`;
  const token = `ExponentPushToken[crew-compass-${run}]`;
  // Earlier runs' saved searches would match too, and a listing is notified once per person; start with none,
  // and with none of the person's own devices from earlier runs.
  await sql(
    `update app.saved_searches set deleted_at = now() where person_id = $1 and deleted_at is null`,
    [DEMO.crew],
  );
  await sql(
    `update app.person_push_devices set deleted_at = now() where person_id = $1 and deleted_at is null`,
    [DEMO.crew],
  );

  // The crew person turns browser notifications on in Gateway and has Compass on a phone: the database calls
  // Gateway's server action and Compass make, as the person.
  await sql(
    `select app.register_web_push('Gateway', $1, $2, $3)`,
    [endpoint, `B${"Cw".repeat(43)}`, "Au".repeat(11)],
    DEMO.crew,
  );
  await sql(`select app.register_push_device($1, 'ios')`, [token], DEMO.crew);
  const devices = await sql<{ id: string; web: boolean }>(
    `select id, web_endpoint is not null as web from app.person_push_devices
      where person_id = $1 and (web_endpoint = $2 or expo_push_token = $3) and revoked_at is null and deleted_at is null`,
    [DEMO.crew, endpoint, token],
    DEMO.crew,
  );
  expect(devices.map((d) => d.web).sort()).toEqual([false, true]);

  // They save a search in Gateway; the org publishes a matching Crew call; the matcher runs as pg_cron would.
  const name = `Delay towers ${run.slice(-4)}`;
  await signIn(page, "crew@example.com", "/explore?role=Crew&q=Truss");
  const save = page.getByRole("form", { name: "Save this search" });
  await save.getByLabel("Search name").fill(name);
  await save.getByRole("button", { name: "Save search" }).click();
  await expect(page.getByText("Search saved. Manage it under Alerts.")).toBeVisible();
  const opp = await publishCrewOpportunity(false);
  await sql("select private.match_saved_searches()");
  const [delivery] = await sql<{ id: string; notification: string }>(
    `select d.id, n.id as notification from app.notifications n
       join app.notification_deliveries d on d.notification_id = n.id and d.notification_created_at = n.created_at
      where n.recipient_person_id = $1 and n.kind = 'opportunity.matched' and n.subject_id = $2 and d.channel = 'Push'`,
    [DEMO.crew, opp.id],
  );
  expect(delivery?.id).toBeTruthy();

  // The push worker runs with the fake Expo and Web Push transports.
  const expo = new RecordingPushClient();
  const web = new RecordingWebPushClient();
  await dispatchPush(pushStore(platformDb), expo, {
    limit: 500,
    web: { store: webPushStore(platformDb), client: web },
  });
  const tickets = await sql<{ device: string; service: string; status: string }>(
    `select t.person_push_device_id::text as device, t.push_service as service, t.message_status::text as status
       from app.push_tickets t where t.notification_delivery_id = $1 order by t.push_service`,
    [delivery?.id],
  );
  const own = new Map(devices.map((d) => [d.id, d.web]));
  expect(tickets.map((t) => [own.get(t.device), t.service, t.status])).toEqual([
    [false, "Expo", "Sent"],
    [true, "Web Push", "Delivered"],
  ]);
  const [status] = await sql<{ status: string }>(
    `select message_status::text as status from app.notification_deliveries where id = $1`,
    [delivery?.id],
  );
  expect(status?.status).toBe("Sent");
  // Only this match's pushes: a delivery left due by an earlier run goes to the person's devices too.
  const mine = delivery?.notification;
  expect(
    expo.sent
      .filter((m) => m.to === token && m.data["notificationId"] === mine)
      .map((m) => m.data["kind"]),
  ).toEqual(["opportunity.matched"]);

  // The browser push opens the listing it names, in Gateway.
  const pushed = web.sent
    .filter((s) => s.device.endpoint === endpoint && s.payload.tag === mine)
    .map((s) => s.payload.url);
  expect(pushed).toEqual([`/explore/${opp.key}`]);
  await page.goto(pushed[0] ?? "/");
  await expect(page.getByRole("form", { name: `Apply for ${opp.title}` })).toBeVisible();
  await expectAccessible(page);

  // Turning browser notifications off revokes the person's own browser.
  await sql(`select app.revoke_web_push($1)`, [endpoint], DEMO.crew);
  await sql(`update app.person_push_devices set deleted_at = now() where expo_push_token = $1`, [
    token,
  ]);
});
