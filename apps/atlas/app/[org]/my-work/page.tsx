import { groupByDueState, listMyWork, type MyWorkRecord } from "@xos/data/my-work";
import { resolveSettings } from "@xos/data/settings";
import { myMembershipId } from "@xos/data/views";
import type { RecordState } from "@xos/ui";
import { getLocale, getTranslations } from "next-intl/server";
import { MyWorkView, type MyWorkRow } from "@/components/my-work/my-work-view";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/client/page-header";
import { requireNode } from "@/components/shell/sitemap-page";
import { pickView } from "@/lib/home/views";
import { enumKey } from "@/lib/projects/format";
import { nodeHref } from "@/lib/shell/sitemap";

const LIMIT = 500;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** YYYY-MM-DD of an instant in a time zone. */
function zonedDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** The first day of the month `offset` months from `month` (YYYY-MM), as YYYY-MM. */
function shiftMonth(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * My Work (Section 4.5.4): the open records the viewer owns, is accountable for or is assigned to,
 * across every project they may read, grouped by when they are due in the viewer's time zone.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/my-work">) {
  const routeParams = await params;
  const search = await searchParams;
  const ctx = await requireNode("my-work", routeParams);
  const [t, p, locale] = await Promise.all([
    getTranslations("myWork"),
    getTranslations("projects"),
    getLocale(),
  ]);
  const header = <PageHeader title={t("title")} />;
  const person = ctx.viewer.person;
  if (!person) {
    return (
      <TemplateCollection header={header}>
        <RefusalPanel
          reason={t("refusal")}
          actionLabel={t("refusalAction")}
          href={nodeHref("home", routeParams) ?? `/${ctx.org.slug}/home`}
        />
      </TemplateCollection>
    );
  }
  const db = ctx.viewer.db;
  const [membership, settings] = await Promise.all([
    myMembershipId(db, { orgId: ctx.org.id, personId: person.id }),
    resolveSettings(db, { orgId: ctx.org.id }),
  ]);
  if (!membership.ok && membership.error.kind !== "not-found") {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("loadError")} />
      </TemplateCollection>
    );
  }
  const records = await listMyWork(db, {
    orgId: ctx.org.id,
    personId: person.id,
    membershipId: membership.ok ? membership.data : null,
    limit: LIMIT,
  });
  if (!records.ok || !settings.ok) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("loadError")} />
      </TemplateCollection>
    );
  }
  if (records.data.length === 0) {
    return (
      <TemplateCollection header={header}>
        <EmptyPanel
          icon="ListChecks"
          sentence={t("empty")}
          actionLabel={t("emptyAction")}
          href={nodeHref("projects", routeParams) ?? `/${ctx.org.slug}/projects`}
        />
      </TemplateCollection>
    );
  }

  const zone = settings.data.get("locale.time_zone")?.value;
  const timeZone = typeof zone === "string" && zone !== "" ? zone : "UTC";
  const now = new Date();
  const stamp = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const state = p as unknown as (key: string) => string;
  const toRow = (r: MyWorkRecord, dueState: MyWorkRow["dueState"]): MyWorkRow => {
    const due = r.dueAt ?? r.endsAt;
    const at = due ?? r.startsAt;
    return {
      key: r.key,
      title: r.title,
      kind: r.kind,
      state: r.state.toLowerCase().replace(" ", "-") as RecordState,
      stateLabel: state(`recordStates.${enumKey(r.state)}`),
      project: `${r.projectKey} ${r.projectName}`,
      when: due
        ? t("due", { when: stamp.format(new Date(due)) })
        : r.startsAt
          ? t("starts", { when: stamp.format(new Date(r.startsAt)) })
          : t("noDate"),
      due: at ? stamp.format(new Date(at)) : t("noDate"),
      dueState,
      date: at ? zonedDay(at, timeZone) : null,
      roles: r.roles.map((role) => t(`roles.${role}`)).join(", "),
    };
  };
  const groups = groupByDueState(records.data, now, timeZone).map((g) => ({
    state: g.state,
    rows: g.records.map((r) => toRow(r, g.state)),
  }));

  const { views, view } = pickView("my-work", search);
  const requested = typeof search["month"] === "string" ? search["month"] : "";
  const month = MONTH.test(requested)
    ? requested
    : zonedDay(now.toISOString(), timeZone).slice(0, 7);
  return (
    <TemplateCollection header={<PageHeader title={t("title")} count={records.data.length} />}>
      <MyWorkView
        groups={groups}
        views={views}
        view={view}
        month={`${month}-01`}
        prevMonth={shiftMonth(month, -1)}
        nextMonth={shiftMonth(month, 1)}
      />
      {records.data.length >= LIMIT ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("truncated", { count: LIMIT })}</p>
      ) : null}
    </TemplateCollection>
  );
}
