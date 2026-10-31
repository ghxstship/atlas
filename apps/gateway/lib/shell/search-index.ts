import type { GatewaySearchHit } from "@xos/data/gateway";
import { gatewaySearchHref } from "@xos/data/gateway";
import { getNode, isNodeVisible, type NavContext, type Sitemap } from "@xos/ia";
import type { SettingDefinition } from "@xos/schemas/settings";
import { enumLabelKey } from "@/lib/enum-key";
import { personalSettings } from "@/lib/settings";

/**
 * Gateway search, the parts that need no request (Section 11.10 item 1, A126): how a result reads and
 * where it opens, the actions, and the settings a search reaches. The server action composes them
 * (lib/shell/search-actions.ts); tests reach them directly. Nothing here ships to the browser.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface SearchResultItem {
  readonly label: string;
  readonly icon: string;
  readonly href: string;
}

export interface SearchResultGroup {
  readonly id: "actions" | "engagements" | "documents" | "messages" | "opportunities" | "settings";
  readonly label: string;
  readonly items: readonly SearchResultItem[];
}

/** Lowercase without accents, for comparing labels with what the person typed. */
export function fold(text: string): string {
  return text.toLocaleLowerCase("es-US").normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
}

/** True when every word appears in the text, ignoring case and accents. */
export function matchesWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const haystack = fold(text);
  return words.every((word) => haystack.includes(fold(word)));
}

const ICONS: Readonly<Record<GatewaySearchHit["type"], string>> = {
  engagement: "BriefcaseBusiness",
  document: "FileText",
  message: "MessagesSquare",
  opportunity: "Compass",
};

/** A result as the menu lists it, or null when Gateway has no page to open it on. */
export function hitItem(hit: GatewaySearchHit, t: Translate): SearchResultItem | null {
  const href = gatewaySearchHref(hit);
  if (!href) return null;
  const org = hit.orgName;
  let label: string;
  switch (hit.type) {
    case "engagement":
      label = t("gatewaySearch.labels.engagement", {
        title:
          hit.title ??
          (hit.kind ? t(enumLabelKey("externalRoleType", hit.kind)) : (hit.detail ?? "")),
        project: hit.detail ?? "",
        org,
      });
      break;
    case "document":
      label = t("gatewaySearch.labels.document", {
        title: hit.title ?? "",
        kind: hit.kind ? t(enumLabelKey("engagementDocumentKind", hit.kind)) : "",
        org,
      });
      break;
    case "message":
      label = hit.detail
        ? t("gatewaySearch.labels.messageText", { subject: hit.title ?? "", text: hit.detail })
        : t("gatewaySearch.labels.message", { subject: hit.title ?? "", org });
      break;
    case "opportunity":
      label = t("gatewaySearch.labels.opportunity", { title: hit.title ?? "", org });
      break;
  }
  return { label, icon: ICONS[hit.type], href };
}

/** Results grouped as the menu shows them, in this order, each group only when it has results. */
export function hitGroups(hits: readonly GatewaySearchHit[], t: Translate): SearchResultGroup[] {
  const order = [
    ["documents", "document"],
    ["messages", "message"],
    ["engagements", "engagement"],
    ["opportunities", "opportunity"],
  ] as const;
  return order.flatMap(([id, type]) => {
    const items = hits
      .filter((h) => h.type === type)
      .map((h) => hitItem(h, t))
      .filter((i): i is SearchResultItem => i !== null);
    return items.length > 0 ? [{ id, label: t(`gatewaySearch.groups.${id}`), items }] : [];
  });
}

/**
 * The verbs a person reaches from search, each on a sitemap node they must be able to open. Pages
 * themselves are listed by the menu from the navigation model; these name the job to be done.
 */
export const GATEWAY_ACTIONS = [
  { key: "findWork", node: "explore", icon: "Search" },
  { key: "jobAlerts", node: "explore.alerts", icon: "BellPlus" },
  { key: "signDocuments", node: "documents", icon: "FileCheck" },
  { key: "messageOrg", node: "messages", icon: "Send" },
  { key: "logTime", node: "money.timesheets", icon: "Clock" },
  { key: "checkPayments", node: "money.payments", icon: "Wallet" },
  { key: "editProfile", node: "profile", icon: "CircleUser" },
  { key: "outOfOffice", node: "settings.out-of-office", icon: "CalendarClock" },
  { key: "notifications", node: "settings.notifications", icon: "Bell" },
] as const;

/** The actions whose words match, on pages the viewer can open. */
export function actionItems(input: {
  readonly words: readonly string[];
  readonly sitemap: Sitemap;
  readonly nav: NavContext;
  readonly t: Translate;
}): SearchResultItem[] {
  const { words, sitemap, nav, t } = input;
  return GATEWAY_ACTIONS.flatMap((a) => {
    if (!isNodeVisible(sitemap, a.node, nav)) return [];
    const route = getNode(sitemap, a.node).node.route;
    const label = t(`gatewaySearch.actions.${a.key}`);
    return route && matchesWords(label, words) ? [{ label, icon: a.icon, href: route }] : [];
  });
}

/**
 * Personal settings whose label, key or section match every word, on the Gateway settings sections the
 * viewer can open (Section 11.11: any setting reached in one search). Each opens its section at the
 * field (`#setting-<key>`, the id the section gives the field).
 */
export function settingItems(input: {
  readonly words: readonly string[];
  readonly sitemap: Sitemap;
  readonly nav: NavContext;
  readonly t: Translate;
  readonly limit?: number;
}): SearchResultItem[] {
  const { words, sitemap, nav, t } = input;
  if (words.length === 0) return [];
  const sections = (getNode(sitemap, "settings").node.children ?? [])
    .map((c) => c.id)
    .filter((id) => isNodeVisible(sitemap, id, nav));
  const out: { item: SearchResultItem; starts: boolean; index: number }[] = [];
  const first = fold(words[0] ?? "");
  for (const section of sections) {
    const page = getNode(sitemap, section).node;
    if (page.route === undefined) continue;
    const pageLabel = t(page.label);
    personalSettings(section).forEach((setting: SettingDefinition) => {
      if (setting.hidden) return;
      const label = t(setting.label);
      if (!matchesWords([label, setting.key.replace(/[._]/g, " "), pageLabel].join(" "), words)) {
        return;
      }
      out.push({
        item: {
          label: t("gatewaySearch.labels.setting", { setting: label, section: pageLabel }),
          icon: "Settings",
          href: `${page.route}#setting-${setting.key.replaceAll(".", "-")}`,
        },
        starts: fold(label).startsWith(first),
        index: out.length,
      });
    });
  }
  return out
    .sort((a, b) => Number(b.starts) - Number(a.starts) || a.index - b.index)
    .slice(0, input.limit ?? 6)
    .map((x) => x.item);
}
