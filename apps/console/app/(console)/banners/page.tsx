import { can, listBanners } from "@xos/data/console";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { BannerForm } from "@/components/banner-form";
import { Empty, PageHeader, Panel, Section } from "@/components/page";
import { endBannerAction } from "@/lib/actions/operations";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("banners.title") };
}

/** System banners (Section 4.10): live and scheduled first, then past ones; publish and end. */
export default async function BannersPage() {
  const ctx = await requirePermission("tenants.read");
  const { t, label, instant } = await getConsoleFormat();
  const result = await listBanners(ctx.db);
  const write = can(ctx.operator, "banners.write");
  return (
    <>
      <PageHeader title={t("banners.title")} intro={t("banners.intro")} />
      {write ? (
        <Section id="new-banner" title={t("banners.new")}>
          <Panel>
            <BannerForm />
          </Panel>
        </Section>
      ) : null}
      <Section id="banners" title={t("banners.title")}>
        {!result.ok ? (
          <Empty>{t("common.loadError")}</Empty>
        ) : result.data.length === 0 ? (
          <Empty>{t("banners.none")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="banners">
            {result.data.map((b) => {
              const ended = b.state === "Ended";
              const state =
                b.state === "Live"
                  ? t("common.live")
                  : ended
                    ? t("common.ended")
                    : t("common.scheduled");
              return (
                <li
                  key={b.id}
                  className="flex flex-col gap-8 rounded-card border border-border-subtle p-12 text-text-13"
                >
                  <span className="flex flex-wrap gap-8">
                    <span className="font-medium">{label("banners.kinds", b.kind)}</span>
                    <span>{label("banners.severities", b.severity)}</span>
                    <span>{label("banners.audiences", b.audience)}</span>
                    <span className="text-text-secondary" data-testid="banner-state">
                      {state}
                    </span>
                  </span>
                  <span>{b.message}</span>
                  {b.messageEs ? <span className="text-text-secondary">{b.messageEs}</span> : null}
                  {b.linkUrl ? <span className="font-mono text-text-12">{b.linkUrl}</span> : null}
                  <span className="text-text-12 text-text-secondary">
                    {b.endsAt
                      ? t("banners.window", {
                          from: instant(b.startsAt),
                          to: instant(b.endedAt ?? b.endsAt),
                        })
                      : t("banners.windowOpen", { from: instant(b.startsAt) })}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t("banners.by", { name: b.createdByName ?? t("common.unknownPerson") })}
                  </span>
                  {write && !ended ? (
                    <ActionForm
                      action={endBannerAction}
                      hidden={{ bannerId: b.id }}
                      submitLabel={t("banners.end")}
                      successLabel={t("banners.endedOk")}
                      variant="secondary"
                      label={t("banners.end")}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}
