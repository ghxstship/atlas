import { getNode } from "@xos/ia";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { EngagementTabNav } from "@/components/engagement/tab-nav";
import { ContinueOnDevice } from "@/components/handoff/continue-on-device";
import { BrandMark, Tag } from "@/components/ui";
import { loadEngagementView, tabHref } from "@/lib/engagement";
import { formatDateRange } from "@/lib/format";
import { handoffLink } from "@/lib/handoff";
import { sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";

export async function generateMetadata({
  params,
}: LayoutProps<"/work/engagements/[engagementKey]">): Promise<Metadata> {
  const { engagementKey } = await params;
  const view = await loadEngagementView(engagementKey);
  return { title: `${view.engagement.jobTitle} · ${view.engagement.orgName}` };
}

/**
 * The engagement record (Section 4.5.8, Section 11.6 Gateway shell: engagement pages use top
 * tabs). The org's identity stays visible (Section 11.12 trust signals); the tabs are the role
 * type's set from the sitemap, narrowed by representation scopes for an artist's representative.
 */
export default async function EngagementLayout({
  children,
  params,
}: LayoutProps<"/work/engagements/[engagementKey]">) {
  const { engagementKey } = await params;
  const view = await loadEngagementView(engagementKey);
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);
  const e = view.engagement;
  // Continue on another device (Section 11.10 item 13, ADR 0030): the same engagement in Compass.
  const handoff = handoffLink({ kind: "engagement", engagementKey });
  return (
    <div className="flex flex-col gap-16">
      <header className="flex flex-col gap-8">
        <Link
          href={"/work/engagements" as Route}
          className="text-text-13 text-text-secondary underline"
        >
          {t("nav.gateway.work.engagements")}
        </Link>
        <div className="flex flex-wrap items-center gap-8 text-text-13 text-text-secondary">
          <BrandMark name={e.orgName} size="sm" iconOnly />
          <span>{e.orgName}</span>
          <span aria-hidden="true">·</span>
          <span>{e.projectName}</span>
        </div>
        <div className="flex flex-wrap items-center gap-12">
          <h1 className="m-0 text-heading-20 font-semibold">{e.jobTitle}</h1>
          <Tag tone={toneFor(e.state)}>{t(enumLabelKey("engagementState", e.state))}</Tag>
          {view.representation ? (
            <Tag tone="accent">
              {t("gateway.engagement.representing", {
                artist: view.representation.artistName ?? "",
              })}
            </Tag>
          ) : null}
          <span className="ms-auto">
            <ContinueOnDevice
              url={handoff.url}
              labels={{
                button: t("handoff.button"),
                title: t("handoff.title"),
                sentence: t(handoff.universal ? "handoff.sentenceUniversal" : "handoff.sentence", {
                  item: e.jobTitle,
                }),
                qr: t("handoff.qr", { item: `${e.jobTitle} · ${e.orgName}` }),
                link: t("handoff.link"),
              }}
            />
          </span>
        </div>
        <p className="m-0 text-text-13 text-text-secondary">
          {formatDateRange(locale, e.startDate, e.endDate)} ·{" "}
          {t(enumLabelKey("externalRoleType", e.roleType))}
        </p>
      </header>
      <EngagementTabNav
        label={t("gateway.engagement.tabs")}
        tabs={view.tabs.map((id) => ({
          id,
          label: t(getNode(sitemap, id).node.label),
          href: tabHref(engagementKey, id),
        }))}
      />
      <div className="flex flex-col gap-16">{children}</div>
    </div>
  );
}
