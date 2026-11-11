import { CLASH_RULES, loadClashes, type ClashRule } from "@xos/data/schedule-clashes";
import { addDays } from "@xos/ui/quick-add";
import { todayIn } from "@xos/data/calendar";
import { getNode } from "@xos/ia";
import {
  capabilitySet,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  type SearchParams,
} from "@/components/work/load";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { ClashesCollection } from "./clashes";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Schedule > Clashes (B4, G-46, G-47): people booked twice, people in transit, suppliers on two productions, artists
 * on two stages, short changeovers, travel too close to a call and running orders past curfew. app.schedule_clashes
 * computes them as the viewer, so a clash shows only to someone who reads both of its sides, and packages/data rates
 * them under the org's thresholds; nothing is stored or fixed automatically. Holders of hospitality.fulfillment.read
 * also get the logged check of requested travel.
 */
export async function ClashesPage({ ctx, search }: { ctx: OrgContext; search: SearchParams }) {
  const t = await getTranslate();
  const node = "schedule.clashes";
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const [meta, caps] = await Promise.all([loadRecordMeta(ctx), capabilitySet(ctx)]);
  const projectKey = param(search, "project") ?? "";
  const project = meta.projects.find((p) => p.key === projectKey);
  const today = todayIn(project?.timeZone ?? (await getOrgTimeZone(ctx)));
  const fromParam = param(search, "from");
  const toParam = param(search, "to");
  const from = fromParam && ISO.test(fromParam) ? fromParam : today;
  const proposedTo = toParam && ISO.test(toParam) ? toParam : addDays(from, 29);
  // At most 92 days, as app.schedule_clashes reads.
  const to =
    proposedTo < from ? from : proposedTo > addDays(from, 91) ? addDays(from, 91) : proposedTo;
  const ruleParam = param(search, "rule");
  const rule = CLASH_RULES.includes(ruleParam as ClashRule) ? (ruleParam as ClashRule) : null;
  const severityParam = param(search, "severity");
  const severity = severityParam === "Clash" || severityParam === "Warning" ? severityParam : null;
  const loaded = must(
    await loadClashes(ctx.viewer.db, {
      orgId: ctx.org.id,
      from,
      to,
      projectId: project?.id ?? null,
    }),
    "clashes",
  );
  const clashes = loaded.clashes.filter(
    (c) => (!rule || c.rule === rule) && (!severity || c.severity === severity),
  );
  return (
    <ClashesCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      views={views}
      view={view}
      from={from}
      to={to}
      projectKey={project ? projectKey : ""}
      rule={rule}
      severity={severity}
      projects={meta.projects}
      clashes={clashes}
      thresholds={loaded.thresholds}
      canCheckTravel={caps.has("hospitality.fulfillment.read")}
    />
  );
}
