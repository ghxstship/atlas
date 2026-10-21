import type { Opportunity } from "@xos/data/gateway";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark, Icon, Tag } from "@/components/ui";
import { formatDate, formatDateRange, formatPayRange } from "@/lib/format";
import { enumLabelKey, type Translate } from "@/lib/shell/translate";

/**
 * An opportunity card that leads with role, pay, date and place in one line (Section 11.12,
 * Discover). Pay shows before anyone applies; no posted pay reads Rate on Request, never zero.
 * The whole card is one link to the opportunity, where the requirements check and Apply live.
 */
export function OpportunityLinkCard({
  opportunity: o,
  locale,
  t,
  extra,
}: {
  opportunity: Opportunity;
  locale: string;
  t: Translate;
  /** Lines under the tags, such as why the listing is recommended and how far away it is. */
  extra?: ReactNode;
}) {
  const pay = o.rateOnRequest
    ? t("gateway.common.rateOnRequest")
    : (formatPayRange(locale, o.payMinMinor, o.payMaxMinor, o.currency) ??
      t("gateway.common.rateOnRequest"));
  const rate = o.rateType ? t(enumLabelKey("rateType", o.rateType)) : null;
  const dates = formatDateRange(locale, o.startsOn, o.endsOn) || t("gateway.common.noDate");
  return (
    <article className="relative flex h-full flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16 text-text-14 focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring">
      <div className="flex items-center gap-6 text-text-12 text-text-secondary">
        <BrandMark name={o.orgName} size="sm" iconOnly />
        <span className="truncate">{o.orgName}</span>
        {o.orgVerified ? (
          <span className="text-state-scheduled">
            <Icon name="BadgeCheck" size={14} label={t("gateway.explore.verified")} />
          </span>
        ) : null}
      </div>
      <h3 className="m-0 text-heading-16 font-semibold">
        <Link
          href={`/explore/${o.key}` as Route}
          className="text-text-primary no-underline after:absolute after:inset-0"
        >
          {o.title}
        </Link>
      </h3>
      <p className="m-0 flex flex-wrap gap-x-12 gap-y-4 text-text-secondary">
        <strong className="font-semibold text-text-primary tabular-nums">
          {pay}
          {rate && !o.rateOnRequest ? ` · ${rate}` : ""}
        </strong>
        <span>{dates}</span>
        {(o.venueName ?? o.venueLocality) ? <span>{o.venueName ?? o.venueLocality}</span> : null}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-6 pt-4">
        <Tag>{t(enumLabelKey("externalRoleType", o.roleType))}</Tag>
        {o.deadlineAt ? (
          <span className="text-text-12 text-text-secondary">
            {t("gateway.explore.deadline", { date: formatDate(locale, o.deadlineAt) })}
          </span>
        ) : null}
      </div>
      {extra}
    </article>
  );
}
