import {
  APP_ENUMS,
  getPublicPersonProfile,
  listAccountMembers,
  listAvailability,
  listRatingsAbout,
  listRepresentations,
  readView,
  representationStanding,
} from "@xos/data/gateway";
import {
  getMyProfile,
  listCarryableCertifications,
  listMyCertifications,
  listMyLanguages,
  listMyLinks,
  listMySkills,
} from "@xos/data/profiles";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { ReplyForm } from "@/components/engagement/forms";
import { SupplierDiversityPanel } from "@/components/profile/supplier-diversity";
import { RowList } from "@/components/engagement/rows";
import { SimpleForm } from "@/components/forms/simple-form";
import { PageTitle, RegionError, Section } from "@/components/page/page";
import { AvailabilityCalendar, ButtonLink, Card, Icon, ProgressBar, Tag } from "@/components/ui";
import {
  acceptRepresentationAction,
  revokeProfileShareAction,
  revokeRepresentationAction,
} from "@/lib/actions/engagement";
import {
  addAvailabilityAction,
  carryCertificationAction,
  removeAvailabilityAction,
} from "@/lib/actions/profile";
import { formatDate, formatDateRange } from "@/lib/format";
import { personToday } from "@/lib/time-zone";
import { profileStrength, STRENGTH_LINKS } from "@/lib/profile";
import { requireNode } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.avatar.profile") };
}

/** Days from blocks, as ISO dates, for the availability calendar. */
function blockDays(
  blocks: readonly { startsAt: string; endsAt: string; kind: string }[],
  kind: string,
): string[] {
  const days: string[] = [];
  for (const b of blocks.filter((x) => x.kind === kind)) {
    const d = new Date(b.startsAt);
    const end = new Date(b.endsAt);
    while (d < end && days.length < 400) {
      days.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return days;
}

/**
 * Profile (Section 4.5.8 avatar menu; Section 11.12 Reputation): the person's own profile with a
 * strength meter naming the next improvement, certifications with verified badges, availability,
 * ratings with public replies, representation and the profile shares they gave. Acting for a
 * company, it shows the company and its team instead.
 */
export default async function ProfilePage() {
  const ctx = await requireNode("profile");
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);

  if (ctx.acting) {
    const members = await listAccountMembers(ctx.db, ctx.acting.id);
    return (
      <>
        <PageTitle
          title={ctx.acting.name}
          lead={ctx.acting.roles.map((r) => t(enumLabelKey("accountRole", r))).join(", ")}
          action={
            <ButtonLink href="/settings/company">
              {t("gateway.profile.company.settings")}
            </ButtonLink>
          }
        />
        <Section title={t("gateway.profile.company.team")}>
          {!members.ok ? (
            <RegionError />
          ) : (
            <RowList
              label={t("gateway.profile.company.team")}
              items={members.data.map((m) => ({
                id: m.membershipId,
                title: m.fullName ?? "",
                meta: [
                  m.roles.map((r) => t(enumLabelKey("accountRole", r))).join(", "),
                  t("gateway.profile.company.since", { date: formatDate(locale, m.validFrom) }),
                ],
              }))}
            />
          )}
        </Section>
        {/* The company's supplier diversity certifications (Section 4.4.1, A65-031). */}
        <SupplierDiversityPanel db={ctx.db} t={t} locale={locale} accountId={ctx.acting.id} />
      </>
    );
  }

  const profile = await getMyProfile(ctx.db);
  if (!profile.ok) {
    return (
      <>
        <PageTitle title={t("nav.gateway.avatar.profile")} />
        <RegionError />
      </>
    );
  }
  const p = profile.data;
  const [
    skills,
    certs,
    languages,
    links,
    availability,
    ratings,
    representations,
    shares,
    carryable,
    calendars,
    publicView,
  ] = await Promise.all([
    listMySkills(ctx.db, ctx.personId),
    listMyCertifications(ctx.db, ctx.personId),
    listMyLanguages(ctx.db, ctx.personId),
    listMyLinks(ctx.db, ctx.personId),
    listAvailability(ctx.db, ctx.personId),
    listRatingsAbout(ctx.db, { personId: ctx.personId }),
    listRepresentations(ctx.db),
    readView(ctx.db, "my_profile_shares", { order: ["shared_at", "desc"] }),
    listCarryableCertifications(ctx.db, ctx.personId),
    readView(ctx.db, "my_availability_calendars", {}),
    getPublicPersonProfile(ctx.db, p.handle),
  ]);
  const count = <T,>(r: { ok: true; data: readonly T[] } | { ok: false }) =>
    r.ok ? r.data.length : 0;
  const blocks = availability.ok ? availability.data : [];
  const strength = profileStrength({
    headline: p.headline,
    city: p.city,
    bio: p.bio,
    skills: count(skills),
    certifications: count(certs),
    rateMinor: p.rateMinor,
    languages: count(languages),
    links: count(links),
    availability: blocks.length,
  });
  // The profile spans every org the person works with, so it follows their own calendar.
  const today = await personToday(ctx);
  const asArtist = representations.ok
    ? representations.data.filter((r) => r.artistPersonId === ctx.personId)
    : [];
  const calendarId = calendars.ok ? (calendars.data.find((c) => c.org_id === null)?.id ?? "") : "";
  const name = p.preferredName ?? ctx.personName ?? p.handle;

  return (
    <>
      <PageTitle
        title={name}
        lead={p.headline ?? t("gateway.profile.noHeadline")}
        eyebrow={
          <span className="inline-flex items-center gap-8">
            <Link href={`/u/${p.handle}` as Route} className="text-accent-text underline">
              {t("gateway.profile.publicLink", { handle: p.handle })}
            </Link>
            <Tag>{t(enumLabelKey("profileVisibility", p.visibility))}</Tag>
          </span>
        }
        action={
          <ButtonLink href="/settings/profile" variant="primary">
            {t("gateway.profile.edit")}
          </ButtonLink>
        }
      />

      <Card title={t("gateway.profile.strength.title")} meta={`${strength.percent}%`}>
        <ProgressBar
          label={
            strength.next
              ? t(`gateway.profile.strength.next.${strength.next}`)
              : t("gateway.profile.strength.complete")
          }
          value={strength.percent}
        />
        {strength.missing.length > 0 ? (
          <div className="flex flex-col gap-8">
            <p
              id="profile-strength-missing"
              className="m-0 text-text-13 font-medium text-text-secondary"
            >
              {t("gateway.profile.strength.missingTitle", { n: strength.missing.length })}
            </p>
            <ul
              aria-labelledby="profile-strength-missing"
              className="m-0 flex list-none flex-col gap-4 p-0"
            >
              {strength.missing.map((step) => (
                <li key={step} className="flex items-center gap-8 text-text-13">
                  <Icon name="Circle" size={14} />
                  <Link href={STRENGTH_LINKS[step] as Route} className="text-accent-text underline">
                    {t(`gateway.profile.strength.missing.${step}`)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Section title={t("gateway.profile.certifications.title")}>
        {!certs.ok ? (
          <RegionError />
        ) : certs.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.profile.certifications.empty")}
          </p>
        ) : (
          <RowList
            label={t("gateway.profile.certifications.title")}
            items={certs.data.map((c) => ({
              id: c.id,
              title: c.name,
              meta: [
                c.issuingBody,
                c.expiresOn
                  ? t("gateway.engagement.documents.expires", {
                      date: formatDate(locale, c.expiresOn),
                    })
                  : null,
              ],
              tag: c.verified
                ? { label: t("gateway.profile.certifications.verified"), tone: "success" as const }
                : {
                    label: t("gateway.profile.certifications.selfReported"),
                    tone: "neutral" as const,
                  },
            }))}
          />
        )}
        {carryable.ok && carryable.data.some((c) => !c.carried) ? (
          <RowList
            label={t("gateway.profile.certifications.carry")}
            items={carryable.data
              .filter((c) => !c.carried)
              .map((c) => ({
                id: c.holderId,
                title: c.name,
                meta: [t("gateway.profile.certifications.recordedBy", { org: c.orgName })],
                action: (
                  <ActionButton
                    action={carryCertificationAction.bind(null, c.holderId)}
                    label={t("gateway.profile.certifications.add")}
                  />
                ),
              }))}
          />
        ) : null}
      </Section>

      <SupplierDiversityPanel db={ctx.db} t={t} locale={locale} accountId={null} />

      <Section title={t("gateway.profile.availability.title")} id="availability">
        <AvailabilityCalendar
          month={`${today.slice(0, 7)}-01`}
          available={blockDays(blocks, "Available")}
          booked={blockDays(blocks, "Unavailable")}
        />
        {blocks.length > 0 ? (
          <RowList
            label={t("gateway.profile.availability.title")}
            items={blocks.map((b) => ({
              id: b.id,
              title: formatDateRange(locale, b.startsAt.slice(0, 10), b.endsAt.slice(0, 10)),
              tag: {
                label: t(enumLabelKey("availabilityKind", b.kind)),
                tone: b.kind === "Available" ? ("success" as const) : ("neutral" as const),
              },
              action: (
                <ActionButton
                  action={removeAvailabilityAction.bind(null, b.id)}
                  label={t("gateway.profile.availability.remove")}
                  variant="ghost"
                />
              ),
            }))}
          />
        ) : null}
        <SimpleForm
          id="availability"
          action={addAvailabilityAction}
          label={t("gateway.profile.availability.add")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("gateway.profile.availability.add")}
          variant="secondary"
          doneLabel={t("gateway.profile.availability.added")}
          resetOnDone
          hidden={{ calendarId, timeZone: "UTC" }}
          fields={[
            {
              name: "start",
              label: t("gateway.profile.availability.start"),
              kind: "date",
              required: true,
            },
            {
              name: "end",
              label: t("gateway.profile.availability.end"),
              kind: "date",
              required: true,
            },
            {
              name: "kind",
              label: t("gateway.profile.availability.kind"),
              kind: "select",
              options: APP_ENUMS.availability_kind.map((k) => ({
                value: k,
                label: t(enumLabelKey("availabilityKind", k)),
              })),
            },
          ]}
        />
      </Section>

      <Section title={t("gateway.profile.ratings.title")}>
        {!ratings.ok ? (
          <RegionError />
        ) : ratings.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.profile.ratings.empty")}
          </p>
        ) : (
          <RowList
            label={t("gateway.profile.ratings.title")}
            items={ratings.data.map((r) => ({
              id: r.id,
              title: t("gateway.profile.public.score", { n: r.score }),
              meta: [r.comment, formatDate(locale, r.submittedAt)],
              detail: r.reply ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("gateway.profile.public.reply", { reply: r.reply })}
                </p>
              ) : (
                <ReplyForm ratingId={r.id} />
              ),
            }))}
          />
        )}
      </Section>

      {asArtist.length > 0 ? (
        <Section title={t("gateway.profile.representation.title")}>
          <RowList
            label={t("gateway.profile.representation.title")}
            items={asArtist.map((r) => {
              const standing = representationStanding(r, today);
              return {
                id: r.id,
                title: r.accountName,
                meta: [
                  r.scopes.map((s) => t(enumLabelKey("representationScope", s))).join(", "),
                  t("gateway.profile.representation.expires", {
                    date: formatDate(locale, r.expiresOn),
                  }),
                ],
                tag: {
                  label: t(`gateway.profile.representation.standing.${standing}`),
                  tone:
                    standing === "active"
                      ? ("success" as const)
                      : standing === "pending"
                        ? ("warning" as const)
                        : ("neutral" as const),
                },
                action:
                  standing === "pending" ? (
                    <span className="inline-flex gap-8">
                      <ActionButton
                        action={acceptRepresentationAction.bind(null, r.id)}
                        label={t("gateway.profile.representation.accept")}
                        variant="secondary"
                      />
                      <ActionButton
                        action={revokeRepresentationAction.bind(null, r.id)}
                        label={t("gateway.profile.representation.decline")}
                        variant="ghost"
                      />
                    </span>
                  ) : standing === "active" ? (
                    <ActionButton
                      action={revokeRepresentationAction.bind(null, r.id)}
                      label={t("gateway.profile.representation.revoke")}
                      variant="ghost"
                    />
                  ) : undefined,
              };
            })}
          />
        </Section>
      ) : null}

      <Section title={t("gateway.profile.shares.title")}>
        {!shares.ok ? (
          <RegionError />
        ) : shares.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.profile.shares.empty")}
          </p>
        ) : (
          <RowList
            label={t("gateway.profile.shares.title")}
            items={shares.data.map((s) => ({
              id: s.id ?? "",
              title: s.org_name ?? "",
              meta: [
                s.shared_at
                  ? t("gateway.profile.shares.shared", { date: formatDate(locale, s.shared_at) })
                  : null,
                s.revoked_at
                  ? t("gateway.profile.shares.revoked", { date: formatDate(locale, s.revoked_at) })
                  : null,
              ],
              ...(!s.revoked_at && s.id
                ? {
                    action: (
                      <ActionButton
                        action={revokeProfileShareAction.bind(null, s.id)}
                        label={t("gateway.profile.shares.revoke")}
                        variant="ghost"
                      />
                    ),
                  }
                : {}),
            }))}
          />
        )}
      </Section>

      {publicView.ok && publicView.data ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("gateway.profile.previewNote")}{" "}
          <Link href={`/u/${p.handle}` as Route} className="text-accent-text underline">
            {t("gateway.profile.preview")}
          </Link>
        </p>
      ) : null}
    </>
  );
}
