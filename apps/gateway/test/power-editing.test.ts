import { readFileSync } from "node:fs";
import { GATEWAY_BULK_RESOURCES } from "@xos/data/gateway-bulk";
import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  actionRows,
  eligibleIds,
  GATEWAY_ACTION_IDS,
  GATEWAY_ACTIONS,
  isGatewayActionId,
  KNOWN_BULK_REFUSALS,
  redoRows,
  refusalKey,
} from "@/lib/bulk/catalog";
import {
  createPacer,
  idsTopic,
  personalChannel,
  personTopic,
  topics,
  type PacerClock,
} from "@/lib/live/topics";
import { buildCsp, realtimeOrigin } from "@/lib/security/headers";

/**
 * Gateway power editing (A122, ADR 0082): the actions a collection takes on a selection, their
 * undo, the live topics each list watches, and the copy every piece reads in en-US and es-US.
 */

const id = (n: number) => `0192${String(n).padStart(4, "0")}-0000-7000-8000-000000000000`;

describe("Gateway bulk actions", () => {
  it("send each action through one of the person's own bulk resources", () => {
    expect(GATEWAY_ACTION_IDS.map((a) => GATEWAY_ACTIONS[a].resource).sort()).toEqual(
      [...GATEWAY_BULK_RESOURCES].sort(),
    );
    expect(isGatewayActionId("submit")).toBe(true);
    expect(isGatewayActionId("approve")).toBe(false);
  });

  it("are undoable only where the server can take them back", () => {
    expect(GATEWAY_ACTIONS.submit.undoable).toBe(true);
    expect(GATEWAY_ACTIONS.sign.undoable).toBe(false);
    expect(GATEWAY_ACTIONS.withdraw.undoable).toBe(false);
  });

  it("set the action's value on every selected row it fits, in the table's order", () => {
    const rows = [
      { id: id(1), eligible: true },
      { id: id(2), eligible: false },
      { id: id(3), eligible: true },
    ];
    const ids = eligibleIds(rows, new Set([id(3), id(2), id(1)]));
    expect(ids).toEqual([id(1), id(3)]);
    expect(actionRows(GATEWAY_ACTIONS.sign, ids)).toEqual([
      { id: id(1), set: { engagement_document_state: "Signed" } },
      { id: id(3), set: { engagement_document_state: "Signed" } },
    ]);
  });

  it("redo the change after an undo, expecting what the undo put back", () => {
    const inverse = [
      {
        id: id(1),
        set: { timesheet_state: "Proposed" },
        expect: { timesheet_state: "Submitted" },
      },
    ];
    expect(redoRows(inverse)).toEqual([
      {
        id: id(1),
        set: { timesheet_state: "Submitted" },
        expect: { timesheet_state: "Proposed" },
      },
    ]);
  });

  it("give known refusals their own copy and everything else the generic one", () => {
    expect(refusalKey("bulk_stale")).toBe("refusals.bulk_stale");
    expect(refusalKey("application_offered")).toBe("refusals.application_offered");
    expect(refusalKey("something_new")).toBe("refusals.refused");
  });
});

describe("Gateway live topics", () => {
  it("narrow a published table to the rows a page shows", () => {
    expect(idsTopic("timesheets", "engagement_id", [id(1), id(1), null, id(2)])).toEqual({
      table: "timesheets",
      filter: `engagement_id=in.(${id(1)},${id(2)})`,
    });
    expect(idsTopic("timesheets", "engagement_id", [])).toBeNull();
    const many = Array.from({ length: 41 }, (_, i) => id(i));
    // More ids than fit in one filter: row level security alone confines the topic.
    expect(idsTopic("engagement_documents", "engagement_id", many)).toEqual({
      table: "engagement_documents",
    });
    expect(personTopic("saved_opportunities", "person_id", id(9))).toEqual({
      table: "saved_opportunities",
      filter: `person_id=eq.${id(9)}`,
    });
    expect(topics(null, personTopic("tax_forms", "person_id", id(9)))).toHaveLength(1);
    expect(personalChannel(id(9))).toBe(`gateway:${id(9)}`);
  });

  it("reread once for a burst of channel pings, and never more often than the interval", () => {
    let now = 0;
    const timers: { at: number; run: () => void }[] = [];
    const clock: PacerClock = {
      now: () => now,
      setTimeout: (run, ms) => {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        const i = timers.indexOf(handle as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
      }
    };
    let reads = 0;
    const pacer = createPacer(() => (reads += 1), { batchMs: 300, minIntervalMs: 2_000, clock });
    pacer.ping();
    pacer.ping();
    pacer.ping();
    advance(300);
    expect(reads).toBe(1);
    pacer.ping();
    advance(300);
    expect(reads).toBe(1);
    advance(1_700);
    expect(reads).toBe(2);
    pacer.ping();
    pacer.stop();
    advance(5_000);
    expect(reads).toBe(2);
  });

  it("may open the Realtime socket, and nothing else beyond the site", () => {
    expect(realtimeOrigin("https://abc.supabase.co")).toBe("wss://abc.supabase.co");
    const csp = buildCsp({
      nonce: "n",
      development: false,
      supabaseOrigin: "https://abc.supabase.co",
      secureSite: true,
    });
    expect(csp).toContain("connect-src 'self' wss://abc.supabase.co;");
  });

  it("watch every collection page", () => {
    const pages = [
      "documents",
      "money/invoices",
      "money/payments",
      "money/tax-documents",
      "money/timesheets",
      "work/applications",
      "work/engagements",
      "explore/saved",
    ];
    for (const page of pages) {
      const source = readFileSync(
        new URL(`../app/(shell)/${page}/page.tsx`, import.meta.url),
        "utf8",
      );
      expect(source, page).toContain("<LiveRefresh");
    }
  });
});

describe("Gateway power editing copy", () => {
  for (const locale of ["en-US", "es-US"] as const) {
    it(`reads every key in ${locale}`, () => {
      const gateway = getMessages(locale)["gateway"] as unknown as {
        collections: Record<string, Record<string, unknown>>;
      };
      const c = gateway.collections;
      for (const actionId of GATEWAY_ACTION_IDS) {
        const copy = c["actions"]?.[actionId] as Record<string, string>;
        const keys = ["one", "bulk", "title", "apply", "willChange", "unchanged", "nothing"];
        for (const key of [...keys, "none", "skipped", "done"]) {
          expect(copy[key], `${actionId}.${key}`).toBeTruthy();
        }
        const note = GATEWAY_ACTIONS[actionId].undoable ? "undoable" : "final";
        expect(copy[note], `${actionId}.${note}`).toBeTruthy();
      }
      for (const rule of [...KNOWN_BULK_REFUSALS, "refused"]) {
        expect(c["refusals"]?.[rule], rule).toBeTruthy();
      }
      for (const key of ["label", "open", "copyLink", "select", "deselect"]) {
        expect(c["menu"]?.[key], `menu.${key}`).toBeTruthy();
      }
      for (const key of ["notifications", "undone", "redone", "failed", "failedPlain"]) {
        expect(c["undo"]?.[key], `undo.${key}`).toBeTruthy();
      }
    });
  }
});
