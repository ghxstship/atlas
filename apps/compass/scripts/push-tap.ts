/**
 * Push taps on the iOS simulator (A101, Section 4.5.7): delivers to Compass a notification about a record, the
 * way the Expo push service hands it to APNs (`xcrun simctl push`, the data in `body`), so the Maestro journey
 * push-tap-opens-record can tap it with Compass closed and open and check that the record opens. The push carries
 * the record key of migration 1600 and the deep link the sender builds; nothing is read from or written to the
 * stack.
 *
 *   node --experimental-strip-types scripts/push-tap.ts serve
 *
 * Needs UDID for the simulator. `serve` answers POST /push on 127.0.0.1 (PUSH_HELPER_PORT, default 57157),
 * because Maestro scripts cannot run simctl themselves.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = "pro.ghxstship.compass";
/** The Inspection record of the demo seed that journey 58 hands off too (supabase/seeds/0217_compass.sql). */
const RECORD_KEY = "NWS-14";
const ORG = "demo-productions";

function push(): void {
  const udid = process.env["UDID"];
  if (!udid) throw new Error("Set UDID.");
  const payload = {
    "Simulator Target Bundle": BUNDLE,
    aps: {
      alert: {
        title: "Assigned to you",
        body: `You were assigned ${RECORD_KEY}: Fire Marshal Walk.`,
      },
      sound: "default",
    },
    body: {
      notificationId: "01920000-0000-7000-8000-00000000a101",
      kind: "assignment.created",
      subjectTable: "app.records",
      subjectId: null,
      title: "Fire Marshal Walk",
      recordKey: RECORD_KEY,
      url: `compass://r/${RECORD_KEY}?org=${ORG}`,
    },
  };
  const file = join(tmpdir(), "xos-push-tap.apns");
  writeFileSync(file, JSON.stringify(payload, null, 2));
  execFileSync("xcrun", ["simctl", "push", udid, BUNDLE, file], { stdio: "inherit" });
}

function serve(): void {
  const port = Number(process.env["PUSH_HELPER_PORT"] ?? 57157);
  createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/push") {
      res.writeHead(404).end();
      return;
    }
    try {
      push();
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    } catch (error) {
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: false, error: String(error) }));
    }
  }).listen(port, "127.0.0.1", () => console.log(`push tap helper on ${port}`));
}

if (process.argv[2] === "serve") serve();
else if (process.argv[2] === "push") push();
else throw new Error("Run with push or serve.");
