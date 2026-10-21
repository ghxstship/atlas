"use server";

import { searchOrg } from "@xos/data/search";
import { getNode, isNodeVisible } from "@xos/ia";
import { getOrgContext } from "@/lib/shell/context";
import { CREATE_KINDS } from "@/lib/shell/create-menu";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * The command menu's server half (Section 11.10 item 1, finding A59-015): records and incidents by
 * key or title, people by name, and the common actions, scoped to what the person may read. It runs
 * on demand as they type, so nothing about the org's data ships in the route bundle; the org context
 * applies the IP allow-list and row level security decides every read.
 */

export interface CommandResultItem {
  readonly label: string;
  readonly code?: string;
  readonly icon: string;
  /** A page to open. */
  readonly href?: string;
  /** A record key to open in the side peek on the current page. */
  readonly peek?: string;
}

export interface CommandResultGroup {
  readonly id: "actions" | "records" | "people";
  readonly label: string;
  readonly items: readonly CommandResultItem[];
}

const RECORD_KINDS = [
  "Approval",
  "Booking",
  "Build",
  "Compliance",
  "Contract",
  "Deadline",
  "Decision",
  "Distribution",
  "Document",
  "Event",
  "Goal",
  "Inspection",
  "Meeting",
  "Milestone",
  "Payment",
  "Permit",
  "Recruitment",
  "Rehearsal",
  "Report",
  "Risk",
  "Shift",
  "Strike",
  "Supply",
  "Task",
  "Timeline",
  "Training",
] as const;

/**
 * The common actions: a verb, the sitemap node that must be visible, and where it leads. The create
 * actions are the Create menu's kinds (lib/shell/create-menu.ts), so they need the same capability and
 * open the same `?create=1` flow; the others open a page, and the menu shows that page's navigation
 * shortcut from the person's keys (packages/schemas/shortcuts.yaml).
 */
const ACTIONS = [
  { key: "newProject", create: "project", path: "projects/all?create=1", icon: "FolderPlus" },
  { key: "newRecord", create: "record", path: "work/all-records?create=1", icon: "Plus" },
  {
    key: "reportIncident",
    create: "incident",
    path: "safety/incidents?create=1",
    icon: "TriangleAlert",
  },
  {
    key: "approveTimesheets",
    node: "crew.timesheets",
    path: "crew/timesheets",
    icon: "CircleCheck",
  },
  { key: "openApprovals", node: "approvals", path: "approvals", icon: "Stamp" },
  { key: "openInbox", node: "inbox", path: "inbox", icon: "Inbox" },
] as const;

/** The sitemap node an action needs to be visible, and the capability it needs, if any. */
function gate(action: (typeof ACTIONS)[number]): { node: string; capability?: string } {
  if ("node" in action) return { node: action.node };
  const kind = CREATE_KINDS.find((k) => k.id === action.create);
  if (!kind) throw new Error(`Unknown create kind ${action.create}`);
  return { node: kind.node, capability: kind.capability };
}

function matches(text: string, query: string): boolean {
  if (query === "") return true;
  const haystack = text.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export async function searchCommandMenu(input: {
  org: string;
  query: string;
}): Promise<CommandResultGroup[]> {
  if (typeof input.org !== "string" || typeof input.query !== "string") return [];
  const ctx = await getOrgContext(input.org);
  if (!ctx) return [];
  const t = await getTranslate();
  const query = input.query.trim().slice(0, 100);
  const org = ctx.org.slug;
  const visible = (node: string) => isNodeVisible(sitemap, node, ctx.nav);

  const actions: CommandResultItem[] = ACTIONS.filter((a) => {
    const { node, capability } = gate(a);
    return visible(node) && (capability === undefined || ctx.capabilities.has(capability));
  })
    .map((a) => ({
      label: t(`shell.commandMenu.actions.${a.key}`),
      icon: a.icon,
      href: `/${org}/${a.path}`,
    }))
    .filter((a) => matches(a.label, query));

  const groups: CommandResultGroup[] = [];
  if (actions.length > 0) {
    groups.push({ id: "actions", label: t("shell.commandMenu.groups.actions"), items: actions });
  }
  if (query.length < 2) return groups;

  const lower = query.toLocaleLowerCase();
  const kinds = RECORD_KINDS.filter((k) => {
    const label = t(`work.kinds.${k}`).toLocaleLowerCase();
    return lower.length >= 3 && (label.startsWith(lower) || lower.startsWith(label));
  });
  const incidentsNode = visible("safety.incidents");
  const incidentsLabel = incidentsNode
    ? t(getNode(sitemap, "safety.incidents").node.label).toLocaleLowerCase()
    : "";
  const result = await searchOrg(ctx.viewer.db, {
    orgId: ctx.org.id,
    query,
    kinds,
    incidents: incidentsNode && lower.length >= 3 && incidentsLabel.startsWith(lower.slice(0, 8)),
  });
  if (!result.ok) return groups;
  const incidentNoun = t("shell.commandMenu.incident");
  const records = result.data.hits
    .filter((h) => h.kind === "record" || incidentsNode)
    .map((h): CommandResultItem =>
      h.kind === "record"
        ? {
            label: `${h.title} · ${t(`work.kinds.${h.recordKind ?? "Task"}`)}`,
            code: h.key,
            icon: "FileText",
            peek: h.key,
          }
        : {
            label: `${h.title} · ${incidentNoun}`,
            code: h.key,
            icon: "TriangleAlert",
            href: `/${org}/safety/incidents?peek=${h.id}`,
          },
    );
  if (records.length > 0) {
    groups.push({ id: "records", label: t("shell.commandMenu.groups.records"), items: records });
  }
  if (visible("people.directory") && result.data.people.length > 0) {
    groups.push({
      id: "people",
      label: t("shell.commandMenu.groups.people"),
      items: result.data.people.map((p) => ({
        label: p.name,
        icon: "User",
        href: `/${org}/people/directory?q=${encodeURIComponent(p.name)}`,
      })),
    });
  }
  return groups;
}
