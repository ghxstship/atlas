import { brandForSlug, openCrewShifts } from "@xos/data/gateway";
import { PARAM_TYPES } from "@xos/ia";
import type { Metadata, Route } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CrewCodeForm, CrewShiftList, type CrewShiftRow } from "@/components/tokens/crew-shifts";
import { BrandMark, Button } from "@/components/ui";
import { forgetCrewCodeAction } from "@/lib/actions/crew-shifts";
import { CODE_COOKIE } from "@/lib/crew-code-cookie";
import { inBrandScope } from "@/lib/brand/brand";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { getRequestFacts } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.tokens.crewShifts");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * My shifts through a crew access link (B10, G-125, ADR 0149 decision 2): a worker sees their own shifts on one project
 * without signing in and accepts their own Published shift. No session and no person are created. Before a right code the
 * page is neutral, with no org or brand. Venues show as text only (S5-29). Every request rechecks through the RPC.
 */
export default async function CrewShiftsPage({ params }: PageProps<"/shifts/[token]">) {
  const { token } = await params;
  if (!PARAM_TYPES.token.test(token)) notFound();
  const t = await getTranslate();
  const saved = (await cookies()).get(CODE_COOKIE)?.value ?? "";
  const heading = (
    <h1 className="m-0 text-heading-20 font-semibold">{t("gateway.tokens.crewShifts.title")}</h1>
  );
  if (!saved) {
    return (
      <>
        {heading}
        <CrewCodeForm token={token} />
      </>
    );
  }
  const db = await createServerSupabase();
  const opened = await openCrewShifts(db, { token, accessCode: saved });
  if (!opened.ok || opened.data.refused) {
    const reason = opened.ok && opened.data.refused ? opened.data.reason : null;
    return (
      <>
        {heading}
        {reason && reason !== "crew_access_access_code" ? (
          <p className="m-0 text-text-14">{t(`gateway.tokens.refusals.${reason}`)}</p>
        ) : (
          <CrewCodeForm token={token} />
        )}
      </>
    );
  }
  const page = opened.data;
  const facts = await getRequestFacts();
  if (!inBrandScope(facts.brand, page.orgId)) notFound();
  const brand = await brandForSlug(db, page.orgSlug);
  const locale = await getLocale();
  const rows: CrewShiftRow[] = page.shifts.map((s) => ({
    id: s.id,
    day: new Intl.DateTimeFormat(locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: s.timeZone,
    }).format(new Date(s.startsAt)),
    call: new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: s.timeZone,
      timeZoneName: "short",
    }).formatRange(new Date(s.startsAt), new Date(s.endsAt)),
    title: s.jobTitle ?? t("gateway.tokens.crewShifts.noRole"),
    show: s.showName,
    venue: [s.venueName, s.venueStreetAddress, s.venueLocality].filter(Boolean).join(", ") || null,
    state: s.state,
    stateLabel: t(enumLabelKey("shiftState", s.state)),
  }));
  return (
    <>
      <div className="flex flex-col gap-8">
        <BrandMark name={brand.ok ? (brand.data?.name ?? page.orgName) : page.orgName} size="sm" />
        {heading}
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.tokens.crewShifts.intro", {
            name: page.personName ?? "",
            project: page.projectName,
          })}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-text-14">{t("gateway.tokens.crewShifts.empty")}</p>
      ) : (
        <CrewShiftList token={token} rows={rows} />
      )}
      <div className="flex flex-wrap items-center gap-12">
        <form action={forgetCrewCodeAction}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" variant="secondary">
            {t("gateway.tokens.crewShifts.forget")}
          </Button>
        </form>
        <Link href={"/auth/sign-in" as Route} className="text-text-13 font-medium text-accent-text">
          {t("gateway.tokens.crewShifts.signIn")}
        </Link>
      </div>
    </>
  );
}
