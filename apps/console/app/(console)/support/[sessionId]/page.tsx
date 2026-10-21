import { openSupportArea, SUPPORT_AREAS, type SupportArea } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { Empty, Facts, PageHeader, Table } from "@/components/page";
import { InlineAlert } from "@/components/ui";
import { endSupportSessionAction } from "@/lib/actions/operations";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.supportSession") };
}

/**
 * One platform support session (Section 8): while it lasts the operator opens one area at a time, read-only, and
 * the org sees each opening (app.support_session_accesses, its audit log). After it ends nothing opens.
 */
export default async function SupportSessionPage({
  params,
  searchParams,
}: PageProps<"/support/[sessionId]">) {
  const { sessionId } = await params;
  if (!z.uuid().safeParse(sessionId).success) notFound();
  const requested = (await searchParams)["area"];
  const area: SupportArea = SUPPORT_AREAS.find((a) => a === requested) ?? "Overview";
  const ctx = await requirePermission("support.sessions");
  const { t, instant, number } = await getConsoleFormat();
  const view = await openSupportArea(ctx.db, sessionId, area);
  if (!view.ok) {
    if (view.error.kind === "not-found") notFound();
    return (
      <>
        <PageHeader title={t("support.title")} />
        <InlineAlert tone="warning">
          {view.error.kind === "refusal" ? t("support.closed") : t("common.loadError")}
        </InlineAlert>
      </>
    );
  }
  const v = view.data;
  const data = v.data;
  return (
    <>
      <PageHeader
        title={t("support.sessionTitle", { org: v.org.name })}
        intro={t("support.sessionIntro", {
          reason: v.session.reason,
          ends: instant(v.session.endsAt),
        })}
      />
      <nav aria-label={t("support.areas")}>
        <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
          {SUPPORT_AREAS.map((a) => (
            <li key={a}>
              <NextLink
                href={`/support/${sessionId}?area=${a}` as Route}
                aria-current={a === area ? "page" : undefined}
                className={`inline-flex h-control-md items-center rounded-control px-8 text-text-13 ${
                  a === area ? "bg-bg-raised font-medium" : "text-accent-text underline"
                }`}
              >
                {t(`support.area.${a}`)}
              </NextLink>
            </li>
          ))}
        </ul>
      </nav>
      <section
        aria-label={t(`support.area.${area}`)}
        data-testid="support-area"
        className="flex flex-col gap-12"
      >
        {data.area === "Overview" ? (
          <Facts
            items={[
              { label: t("support.counts.members"), value: number(data.counts.members) },
              { label: t("support.counts.projects"), value: number(data.counts.projects) },
              {
                label: t("support.counts.activeProjects"),
                value: number(data.counts.activeProjects),
              },
              { label: t("support.counts.workspaces"), value: number(data.counts.workspaces) },
              { label: t("support.counts.settings"), value: number(data.counts.settings) },
              { label: t("support.counts.openTickets"), value: number(data.counts.openTickets) },
            ]}
          />
        ) : data.area === "Members" ? (
          data.members.length === 0 ? (
            <Empty>{t("support.empty")}</Empty>
          ) : (
            <Table
              caption={t("support.area.Members")}
              columns={[
                t("support.member"),
                t("support.email"),
                t("support.roles"),
                t("support.joined"),
              ]}
              rows={data.members.map((m, i) => ({
                key: `${m.email ?? ""}-${i}`,
                cells: [
                  m.name ?? t("common.unknownPerson"),
                  m.email ?? t("common.none"),
                  m.roles.join(", "),
                  instant(m.joined),
                ],
              }))}
            />
          )
        ) : data.area === "Projects" ? (
          data.projects.length === 0 ? (
            <Empty>{t("support.empty")}</Empty>
          ) : (
            <Table
              caption={t("support.area.Projects")}
              columns={[
                t("support.project"),
                t("support.state"),
                t("support.dates"),
                t("support.timeZone"),
              ]}
              rows={data.projects.map((p) => ({
                key: p.key,
                cells: [
                  `${p.key} ${p.name}`,
                  p.archived ? `${p.state}, ${t("support.archived")}` : p.state,
                  [p.startsOn, p.endsOn].filter((x): x is string => x !== null).join(" / ") ||
                    t("common.none"),
                  p.timeZone,
                ],
              }))}
            />
          )
        ) : data.settings.length === 0 ? (
          <Empty>{t("support.empty")}</Empty>
        ) : (
          <Table
            caption={t("support.area.Settings")}
            columns={[t("support.setting"), t("support.value"), t("support.locked")]}
            rows={data.settings.map((s) => ({
              key: s.key,
              cells: [
                <code key="k" className="font-mono">
                  {s.key}
                </code>,
                s.value ?? t("common.none"),
                s.locked ? t("common.yes") : t("common.no"),
              ],
            }))}
          />
        )}
      </section>
      <ActionForm
        action={endSupportSessionAction}
        hidden={{ sessionId }}
        submitLabel={t("support.end")}
        variant="secondary"
        label={t("support.end")}
      />
    </>
  );
}
