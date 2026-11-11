/**
 * What Today's search looks through (A126, ADR 0088): the documents built from the device's offline store.
 * Each kind reads the rows the screen it opens lists, with that screen's filters, so a result always lands on
 * a page that shows it: shifts as My shifts lists them, external records as their More page does
 * (src/domain/external.ts), published SOPs only, and the emergency codes Reference shows, the canon ones
 * included. A kind whose screen this person cannot open is left out.
 */
import { isInternal, type Row } from "@xos/sync";
import { moreMenu, operationalEngagements, type CompassIdentity, type Feature } from "./access";
import {
  emergencyCodesFor,
  type CanonEmergencyCodeRow,
  type OrgEmergencyCodeRow,
} from "./emergencyCodes";
import { rowsOnProject, SUBMITTAL_KINDS, type ExternalPageId } from "./external";
import { actionDocs, type LocalSearchDoc } from "./search";
import { isMine, type ShiftRow } from "./shifts";

export interface SearchDocsInput {
  readonly identity: CompassIdentity;
  readonly projectId: string | null;
  /** Local rows of a downloaded table. */
  readonly rows: (table: string) => readonly Row[];
  readonly allowed: (feature: Feature) => boolean;
  /** Translates a catalog key. */
  readonly t: (key: string, values?: Readonly<Record<string, string>>) => string;
  /** The shift's role title, as My shifts shows it. */
  readonly shiftTitle: (shift: ShiftRow) => string;
  /** The shift's day and time in its schedule zone. */
  readonly shiftWhen: (shift: ShiftRow) => string;
  readonly now: number;
}

/** The tables Today's search reads; the screen keeps them live. */
export const SEARCH_TABLES = [
  "shifts",
  "projects",
  "onboarding_items",
  "deliverables",
  "shared_records",
  "purchase_orders",
  "incidents",
  "kiosk_roster",
  "sops",
  "emergency_codes",
  "canon_emergency_codes",
  "radio_channels",
] as const;

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);
const field = (row: Row, key: string): string | null => {
  const v = row[key];
  return typeof v === "string" && v !== "" ? v : null;
};

export function searchDocs(input: SearchDocsInput): LocalSearchDoc[] {
  const { identity, projectId, rows, allowed, t } = input;
  const out: LocalSearchDoc[] = [];
  const projectName = new Map(rows("projects").map((p) => [p.id, text(p["name"])]));

  // My shifts: the person's own on the chosen project, not yet over and not drafts (groupByDay).
  const me = {
    membershipId: identity.membershipId,
    engagementIds: operationalEngagements(identity, null).map((e) => e.id),
  };
  for (const row of rows("shifts")) {
    const s = row as unknown as ShiftRow;
    if (s.project_id !== projectId || !isMine(s, me) || s.shift_state === "Draft") continue;
    if (Date.parse(s.ends_at) < input.now) continue;
    out.push({
      kind: "shift",
      id: s.id,
      title: input.shiftTitle(s) || t("compass.schedule.myShifts"),
      body: projectName.get(s.project_id) ?? "",
      subtitle: input.shiftWhen(s),
      at: s.starts_at,
      href: "/schedule",
    });
  }

  // External More pages, each only when the person's menu has it, with the page's project rule.
  const pages = new Set(moreMenu(identity.audience).map((m) => m.id));
  const onPage = (page: ExternalPageId, table: string): Row[] =>
    pages.has(page) ? rowsOnProject(rows(table), projectId, identity.engagements) : [];
  for (const o of onPage("onboarding", "onboarding_items")) {
    if (o["satisfied"] === true) continue;
    out.push({
      kind: "task",
      id: o.id,
      title: text(o["name"]),
      at: field(o, "expires_on"),
      href: "/onboarding",
    });
  }
  for (const d of onPage("deliverables", "deliverables")) {
    if (d["deliverable_state"] === "Accepted") continue;
    out.push({
      kind: "task",
      id: d.id,
      title: text(d["title"]),
      at: field(d, "due_at"),
      href: "/deliverables",
    });
  }
  for (const r of onPage("submittals", "shared_records")) {
    const kind = field(r, "record_kind") ?? "";
    if (!SUBMITTAL_KINDS.includes(kind)) continue;
    out.push({
      kind: "record",
      id: r.id,
      title: text(r["title"]),
      body: kind,
      at: field(r, "due_at"),
      href: "/submittals",
    });
  }
  for (const p of onPage("purchase-orders", "purchase_orders")) {
    out.push({
      kind: "record",
      id: p.id,
      title: t("compassSearch.purchaseOrder", { number: text(p["po_number"]) }),
      body: [text(p["org_name"]), text(p["project_name"])].join(" "),
      code: text(p["po_number"]),
      at: field(p, "sent_at"),
      href: "/purchase-orders",
    });
  }

  // The incident log of the chosen project, behind the same gate as its screen.
  if (allowed("incidents.report")) {
    for (const i of rows("incidents")) {
      if (i["project_id"] !== projectId) continue;
      out.push({
        kind: "record",
        id: i.id,
        title: text(i["title"]),
        code: text(i["incident_number"]),
        at: field(i, "occurred_at"),
        href: "/incidents",
      });
    }
  }

  // People open the Workforce directory, which only members of the org reach, searched for the name.
  if (isInternal(identity.audience) && identity.membershipId) {
    for (const p of rows("kiosk_roster")) {
      const name = field(p, "display_name");
      if (!name) continue;
      out.push({
        kind: "person",
        id: p.id,
        title: name,
        href: `/workforce/directory?q=${encodeURIComponent(name)}`,
      });
    }
  }

  // Reference: published SOPs, the emergency codes Reference lists, the chosen project's radio channels.
  for (const s of rows("sops")) {
    if (field(s, "published_at") === null) continue;
    out.push({
      kind: "reference",
      id: s.id,
      title: text(s["title"]),
      body: text(s["body"]),
      code: text(s["code"]),
      href: "/reference/sops",
    });
  }
  const { codes } = emergencyCodesFor(
    rows("emergency_codes") as unknown as OrgEmergencyCodeRow[],
    rows("canon_emergency_codes") as unknown as CanonEmergencyCodeRow[],
  );
  for (const c of codes) {
    out.push({
      kind: "reference",
      id: c.key,
      title: c.label,
      body: c.emergency,
      code: c.code,
      href: "/reference/emergency-codes",
    });
  }
  for (const c of rows("radio_channels")) {
    if (c["project_id"] !== projectId) continue;
    out.push({
      kind: "reference",
      id: c.id,
      title: text(c["name"]),
      code: text(c["channel_number"]),
      subtitle: t("compassSearch.channel", { number: text(c["channel_number"]) }),
      href: "/reference/radio-channels",
    });
  }

  out.push(...actionDocs(allowed, (key) => t(`compassSearch.actions.${key}`)));
  return out;
}
