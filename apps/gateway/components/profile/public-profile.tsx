import type { PublicPersonProfileFull, Rating } from "@xos/data/gateway";
import type { Route } from "next";
import Link from "next/link";
import { Section } from "@/components/page/page";
import { Avatar, Icon, Tag } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { enumLabelKey, type Translate } from "@/lib/shell/translate";

/**
 * A person's profile as the viewer may see it (Section 4.8.2, Section 11.12 Reputation): the
 * portfolio-style header, verified certifications, skills with their canon codes, portfolio and
 * EPK, languages, references, links, released ratings and the organizations they worked with.
 * Sections the viewer may not see arrive empty from api_public and do not render.
 */
export function PublicPersonProfile({
  data,
  ratings,
  locale,
  t,
}: {
  data: PublicPersonProfileFull;
  ratings: readonly Rating[];
  locale: string;
  t: Translate;
}) {
  const p = data.profile;
  const name = p.preferred_name ?? p.full_name ?? p.handle;
  const place = [p.city, p.country_code].filter(Boolean).join(", ");
  const rate = formatMoney(locale, p.rate_minor, p.rate_currency);
  return (
    <article className="flex flex-col gap-24">
      <header className="flex flex-wrap items-center gap-16">
        <Avatar name={name} size="lg" />
        <div className="flex min-w-0 flex-col gap-4">
          <h1 className="m-0 text-heading-24 font-semibold">{name}</h1>
          {p.headline ? <p className="m-0 text-text-16 text-text-secondary">{p.headline}</p> : null}
          <p className="m-0 flex flex-wrap gap-x-12 gap-y-4 text-text-13 text-text-secondary">
            {p.pronouns ? <span>{p.pronouns}</span> : null}
            {place ? <span>{place}</span> : null}
            {rate ? (
              <span className="font-semibold text-text-primary tabular-nums">
                {rate}
                {p.rate_unit ? ` ${t(enumLabelKey("rateUnit", p.rate_unit))}` : ""}
              </span>
            ) : null}
          </p>
        </div>
      </header>
      {p.bio ? <p className="m-0 max-w-layout-reading whitespace-pre-line text-text-14">{p.bio}</p> : null}

      {data.certifications.length > 0 ? (
        <Section title={t("gateway.profile.public.certifications")}>
          <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
            {data.certifications.map((c) => (
              <li key={`${c.name}-${c.issued_on ?? ""}`} className="inline-flex items-center gap-6 rounded-pill border border-border-subtle px-12 py-4 text-text-13">
                {c.verified ? (
                  <span className="text-success">
                    <Icon name="BadgeCheck" size={14} label={t("gateway.profile.public.verified", { org: c.verified_by ?? "" })} />
                  </span>
                ) : null}
                {c.name}
                {c.expires_on ? <span className="text-text-secondary">{t("gateway.engagement.documents.expires", { date: formatDate(locale, c.expires_on) })}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {data.skills.length > 0 ? (
        <Section title={t("gateway.profile.public.skills")}>
          <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
            {data.skills.map((s) => (
              <li key={s.cat_urid} className="inline-flex items-center gap-6 rounded-pill border border-border-subtle px-12 py-4 text-text-13">
                {s.category}
                <span className="font-mono text-text-12 text-text-secondary">{s.cat_urid}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {data.portfolio.length > 0 ? (
        <Section title={t("gateway.profile.public.portfolio")}>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0">
            {data.portfolio.map((item) => (
              <li key={`${item.title}-${item.url ?? item.media_path ?? ""}`} className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-12">
                <span className="flex items-center gap-6">
                  <Tag>{t(enumLabelKey("portfolioKind", item.portfolio_kind))}</Tag>
                  {item.is_epk ? <Tag tone="accent">{t("gateway.profile.public.epk")}</Tag> : null}
                </span>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-text underline">
                    {item.title}
                  </a>
                ) : (
                  <span className="font-medium">{item.title}</span>
                )}
                {item.description ? <span className="text-text-13 text-text-secondary">{item.description}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {data.languages.length > 0 ? (
        <Section title={t("gateway.profile.public.languages")}>
          <p className="m-0 text-text-14">
            {data.languages
              .map((l) => [l.language_tag, l.proficiency ? t(enumLabelKey("languageProficiency", l.proficiency)) : null].filter(Boolean).join(" · "))
              .join(", ")}
          </p>
        </Section>
      ) : null}

      {data.references.length > 0 ? (
        <Section title={t("gateway.profile.public.references")}>
          <ul className="m-0 flex list-none flex-col gap-12 p-0">
            {data.references.map((r) => (
              <li key={r.referee_name} className="flex flex-col gap-2">
                <strong>{r.referee_name}</strong>
                <span className="text-text-13 text-text-secondary">{[r.relationship, r.organization_name].filter(Boolean).join(" · ")}</span>
                {r.statement ? <span className="text-text-14">{r.statement}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {ratings.length > 0 ? (
        <Section title={t("gateway.profile.public.ratings")}>
          <ul className="m-0 flex list-none flex-col gap-12 p-0">
            {ratings.map((r) => (
              <li key={r.id} className="flex flex-col gap-4 rounded-card border border-border-subtle p-12">
                <span className="font-semibold" aria-label={t("gateway.profile.public.score", { n: r.score })}>
                  {t("gateway.profile.public.score", { n: r.score })}
                </span>
                {r.comment ? <span className="text-text-14">{r.comment}</span> : null}
                <span className="text-text-12 text-text-secondary">{formatDate(locale, r.submittedAt)}</span>
                {r.reply ? (
                  <span className="border-s-(length:--stroke-width-accent) border-border-subtle ps-8 text-text-13 text-text-secondary">
                    {t("gateway.profile.public.reply", { reply: r.reply })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {data.organizations.length > 0 ? (
        <Section title={t("gateway.profile.public.organizations")}>
          <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
            {data.organizations.map((o) => (
              <li key={o.handle}>
                <Link href={`/c/${o.handle}` as Route} className="text-accent-text underline">
                  {o.name}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {data.links.length > 0 ? (
        <Section title={t("gateway.profile.public.links")}>
          <ul className="m-0 flex list-none flex-wrap gap-12 p-0">
            {data.links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer me" className="inline-flex items-center gap-4 text-accent-text underline">
                  {l.label}
                  <Icon name="ExternalLink" size={12} />
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}
