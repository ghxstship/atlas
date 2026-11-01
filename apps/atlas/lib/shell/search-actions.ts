"use server";

import { embeddingProviderFromEnv, type EmbeddingProvider } from "@xos/ai/embeddings";
import {
  globalSearch,
  recentItems,
  searchContext,
  type RecentItem,
  type SearchHit,
} from "@xos/data/search";
import {
  hasSearchCriteria,
  isPlainSearch,
  parseSearchQuery,
  searchRequest,
  semanticText,
} from "@xos/data/search-query";
import { isNodeVisible } from "@xos/ia";
import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import { SETTINGS } from "@xos/schemas/settings";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { CREATE_KINDS } from "@/lib/shell/create-menu";
import {
  matchesWords,
  queryVector,
  resolveKinds,
  resolveStatuses,
  settingEntries,
} from "@/lib/shell/search-index";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { observability } from "@/lib/observability";

/**
 * The command menu's server half (Section 11.10 item 1, Section 11.7; findings A59-015 and A65-005). Before
 * anything is typed: the last things the person opened and the common actions. As they type: records,
 * incidents, people, documents, SOPs and handbook articles from app.global_search (the operator grammar,
 * read with the person's own row level security, blended with semantic matches when the org has semantic
 * search on), the settings whose label or key matches, and the actions. It runs on demand, so nothing about
 * the org's data or the settings registry ships in the route bundle; the org context applies the IP
 * allow-list.
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
  readonly id: "recent" | "actions" | "records" | "people" | "documents" | "settings";
  readonly label: string;
  readonly items: readonly CommandResultItem[];
}

/**
 * The common actions: a verb, the sitemap node that must be visible, and where it leads. The create
 * actions are the Create menu's kinds (lib/shell/create-menu.ts), so they need the same capability and
 * open the same `?create=1` flow; the others open a page.
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
function gate(action: (typeof ACTIONS)[number]): { node: string; capability?: CapabilityCode } {
  if ("node" in action) return { node: action.node };
  const kind = CREATE_KINDS.find((k) => k.id === action.create);
  if (!kind) throw new Error(`Unknown create kind ${action.create}`);
  return { node: kind.node, capability: kind.capability };
}

type Item = Pick<SearchHit, "type" | "id" | "key" | "title" | "recordKind"> & {
  readonly matched?: SearchHit["matched"];
};

/**
 * The embedding provider: Supabase's gte-small by default, reached through the search-embed Edge Function
 * with the person's own session (it embeds only for a member of an org with semantic search on), or what
 * XOS_SEARCH_EMBEDDINGS names. A misconfiguration leaves search lexical.
 */
function embeddingProvider(ctx: OrgContext): EmbeddingProvider | null {
  try {
    return embeddingProviderFromEnv(process.env, {
      remoteGteSmall: async (text) => {
        const { data, error } = await ctx.viewer.db.functions.invoke("search-embed", {
          body: { org_id: ctx.org.id, text },
        });
        if (error) throw new Error(`search-embed: ${String(error.message ?? error)}`);
        const vector = (data as { vector?: unknown } | null)?.vector;
        if (!Array.isArray(vector)) throw new Error("search-embed returned no vector");
        return vector as number[];
      },
    });
  } catch (error) {
    observability.logger.error("Semantic search is unavailable", { error: error });
    return null;
  }
}

export async function searchCommandMenu(input: {
  org: string;
  query: string;
}): Promise<CommandResultGroup[]> {
  if (typeof input.org !== "string" || typeof input.query !== "string") return [];
  const ctx = await getOrgContext(input.org);
  if (!ctx) return [];
  const t = await getTranslate();
  const query = input.query.trim().slice(0, 200);
  const org = ctx.org.slug;
  const visible = (node: string) => isNodeVisible(sitemap, node, ctx.nav);
  const parsed = parseSearchQuery(query);
  const words = [...parsed.terms, ...parsed.phrases];
  // Under is:archived every document hit is archived, and the documents list shows it only when asked.
  const documentScope = parsed.is.includes("archived") ? "&archived=only" : "";

  /** Where a result opens, or null when its page is not one the person may open. */
  const target = (item: Item): Pick<CommandResultItem, "href" | "peek"> | null => {
    switch (item.type) {
      case "record":
        return item.key ? { peek: item.key } : null;
      case "incident":
        return visible("safety.incidents")
          ? { href: `/${org}/safety/incidents?peek=${item.id}` }
          : null;
      case "person":
        return visible("people.directory")
          ? { href: `/${org}/people/directory?q=${encodeURIComponent(item.title)}` }
          : null;
      case "document":
        return visible("knowledge.documents")
          ? { href: `/${org}/knowledge/documents?peek=${item.id}${documentScope}` }
          : null;
      case "sop":
        return visible("knowledge.sops")
          ? { href: `/${org}/knowledge/sops?peek=${item.id}` }
          : null;
      case "article":
        return visible("knowledge.handbook")
          ? { href: `/${org}/knowledge/handbook?peek=${item.id}` }
          : null;
    }
  };
  const toItem = (item: Item): CommandResultItem | null => {
    const where = target(item);
    if (!where) return null;
    const noun =
      item.type === "record"
        ? t(`work.kinds.${item.recordKind ?? "Task"}`)
        : t(`shell.commandMenu.types.${item.type}`);
    const related = item.matched === "semantic" ? ` · ${t("shell.commandMenu.related")}` : "";
    return {
      label: item.type === "person" ? item.title : `${item.title} · ${noun}${related}`,
      ...(item.key ? { code: item.key } : {}),
      icon: ICONS[item.type],
      ...where,
    };
  };

  const actions: CommandResultItem[] = ACTIONS.filter((a) => {
    const { node, capability } = gate(a);
    return visible(node) && (capability === undefined || ctx.capabilities.has(capability));
  })
    .map((a) => ({
      label: t(`shell.commandMenu.actions.${a.key}`),
      icon: a.icon,
      href: `/${org}/${a.path}`,
    }))
    .filter((a) => isPlainSearch(parsed) && matchesWords(a.label, words));
  const actionGroup = (): CommandResultGroup[] =>
    actions.length > 0
      ? [{ id: "actions", label: t("shell.commandMenu.groups.actions"), items: actions }]
      : [];

  // Before anything is typed: what the person opened last, then the actions (Section 11.7).
  if (query === "") {
    const recent = await recentItems(ctx.viewer.db, ctx.org.id, 50);
    const items = recent.ok ? recent.data.map((r: RecentItem) => toItem(r)).filter(isItem) : [];
    return [
      ...(items.length > 0
        ? [{ id: "recent" as const, label: t("shell.commandMenu.groups.recent"), items }]
        : []),
      ...actionGroup(),
    ];
  }

  const groups: CommandResultGroup[] = [];
  const plainText = words.join(" ");
  if (hasSearchCriteria(parsed) && (plainText.length >= 2 || !isPlainSearch(parsed))) {
    const provider = embeddingProvider(ctx);
    const vector = await queryVector({
      provider,
      text: semanticText(parsed),
      semanticEnabled: async () => {
        const context = await searchContext(ctx.viewer.db, ctx.org.id);
        return context.ok && context.data.semanticEnabled;
      },
    });
    const request = searchRequest(parsed, {
      kinds: resolveKinds(parsed.kinds, t),
      excludeKinds: resolveKinds(parsed.excludeKinds, t),
    });
    const result = await globalSearch(ctx.viewer.db, {
      orgId: ctx.org.id,
      request: {
        ...request,
        statuses: resolveStatuses(request.statuses, t),
        exclude_statuses: resolveStatuses(request.exclude_statuses, t),
      },
      embedding: vector?.literal ?? null,
      model: vector?.model ?? null,
      limit: 8,
      ...(vector ? { minSimilarity: vector.minSimilarity } : {}),
    });
    if (!result.ok && result.error.kind !== "refusal") {
      observability.logger.error("Command menu search failed", { error: result.error });
    }
    const hits = result.ok ? result.data : [];
    const pick = (types: readonly SearchHit["type"][]) =>
      hits
        .filter((h) => types.includes(h.type))
        .map(toItem)
        .filter(isItem);
    const records = pick(["record", "incident"]);
    const people = pick(["person"]);
    const documents = pick(["document", "sop", "article"]);
    if (records.length > 0)
      groups.push({ id: "records", label: t("shell.commandMenu.groups.records"), items: records });
    if (people.length > 0)
      groups.push({ id: "people", label: t("shell.commandMenu.groups.people"), items: people });
    if (documents.length > 0)
      groups.push({
        id: "documents",
        label: t("shell.commandMenu.groups.documents"),
        items: documents,
      });
  }

  if (isPlainSearch(parsed)) {
    const settings = settingEntries({
      settings: SETTINGS,
      words,
      sitemap,
      nav: ctx.nav,
      params: { org },
      t,
    }).map((s) => ({ label: s.label, code: s.key, icon: s.icon, href: s.href }));
    if (settings.length > 0)
      groups.push({
        id: "settings",
        label: t("shell.commandMenu.groups.settings"),
        items: settings,
      });
  }
  return [...actionGroup(), ...groups];
}

const ICONS: Readonly<Record<SearchHit["type"], string>> = {
  record: "FileText",
  incident: "TriangleAlert",
  person: "User",
  document: "File",
  sop: "ClipboardList",
  article: "BookOpen",
};

function isItem(item: CommandResultItem | null): item is CommandResultItem {
  return item !== null;
}
