import {
  certificateStatus,
  getCertificationHolder,
  listCertificationHolders,
  listCertifications,
  type CertificationHolder,
} from "@xos/data/people";
import { personNames } from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  createCertificationAction,
  recordHolderAction,
  removeHolderAction,
} from "@/app/[org]/people/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { InlineAlert } from "@/components/crew/ui";
import { PeekCalendar } from "@/components/crew/views-peek-calendar";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, getMembers, withParams } from "@/lib/crew/context";
import { peopleStateIcon } from "@/lib/people/states";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { nodeHref } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/**
 * People > Certifications (Section 4.5.5): certificates people hold, with expiry, in table, list and
 * calendar views. A certificate is recorded and verified by someone other than its holder (invariant
 * 21), and an expired one no longer qualifies the person for open shifts (journey 66).
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/people/certifications">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "people.certifications";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  // Expiry follows the org's calendar, as the database's certification dates do (1306).
  const today = await orgToday(crew.ctx);
  const [certsResult, holdersResult] = await Promise.all([
    listCertifications(db, crew.orgId),
    listCertificationHolders(db, { orgId: crew.orgId }),
  ]);
  if (!certsResult.ok) throw new Error(`Cannot list certifications: ${certsResult.error.kind}`);
  if (!holdersResult.ok) throw new Error(`Cannot list certificates: ${holdersResult.error.kind}`);
  const certs = certsResult.data;
  const holders = holdersResult.data;
  const canVerify = crew.can("people.certification.verify");
  const status = (h: CertificationHolder) => certificateStatus(h.expiresOn, today);
  const name = (h: CertificationHolder) => h.personName ?? t("crew.common.unnamed");
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });
  const expiring = holders.filter((h) => status(h) !== "current").length;

  let peek = null;
  if (search["peek"]) {
    const detail = await getCertificationHolder(db, search["peek"]);
    if (detail.ok) {
      const h = detail.data;
      const verifier = await personNames(db, [h.verifiedBy]);
      const record = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          kindLabel={t("people.kinds.certificate")}
          recordKey={h.issuingBody}
          title={t("people.certs.title", { name: name(h), certification: h.certificationName })}
          state={peopleStateIcon("certificate", status(h))}
          stateLabel={t(`people.certs.status.${status(h)}`)}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={
            canVerify ? (
              <ConfirmButton
                label={t("people.certs.remove")}
                title={t("people.certs.removeTitle")}
                description={t("people.certs.removeHelp")}
                defaultReason={t("people.certs.remove")}
                reason={false}
                action={removeHolderAction}
                hidden={{ org: crew.slug, id: h.id }}
                variant="danger"
              />
            ) : null
          }
          properties={[
            { label: t("crew.fields.person"), value: name(h) },
            { label: t("people.certs.certification"), value: h.certificationName },
            { label: t("people.certs.issuingBody"), value: h.issuingBody },
            { label: t("people.certs.issued"), value: day(h.issuedOn) },
            {
              label: t("people.certs.expires"),
              value: h.expiresOn ? day(h.expiresOn) : t("people.certs.noExpiry"),
            },
            {
              label: t("people.certs.verifiedBy"),
              value:
                (h.verifiedBy && verifier.ok ? verifier.data.get(h.verifiedBy) : null) ??
                t("crew.record.someone"),
            },
            {
              label: t("people.certs.public"),
              value: h.publicVerification
                ? t("people.certs.publicOn")
                : t("people.certs.publicOff"),
            },
          ]}
        />
      );
      if (search["full"] === "1") return record;
      peek = record;
    } else if (!peekRowMissing(detail.error)) {
      throw new Error(`Cannot read certificate: ${detail.error.kind}`);
    }
  }

  let drawer = null;
  if (search["create"] === "1" && canVerify && certs.length > 0) {
    const members = await getMembers(crew.ctx);
    drawer = (
      <DrawerForm
        title={t("people.certs.recordTitle")}
        submitLabel={t("people.certs.record")}
        action={recordHolderAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          {
            kind: "select",
            name: "certificationId",
            label: t("people.certs.certification"),
            options: certs.map((c) => ({
              value: c.id,
              label: t("crew.common.pair", { a: c.name, b: c.issuingBody }),
            })),
          },
          {
            kind: "select",
            name: "personId",
            label: t("people.certs.holder"),
            help: t("people.certs.holderHelp"),
            options: members.flatMap((m) =>
              m.personId && m.personId !== crew.ctx.viewer.person?.id
                ? [{ value: m.personId, label: m.name ?? t("crew.common.unnamed") }]
                : [],
            ),
          },
          {
            kind: "date",
            name: "issuedOn",
            label: t("people.certs.issued"),
            value: today,
            required: true,
          },
          {
            kind: "date",
            name: "expiresOn",
            label: t("people.certs.expires"),
            help: t("people.certs.expiresHelp"),
          },
        ]}
      />
    );
  } else if (
    (search["newType"] === "1" || (search["create"] === "1" && certs.length === 0)) &&
    canVerify
  ) {
    drawer = (
      <DrawerForm
        title={t("people.certs.typeTitle")}
        submitLabel={t("people.certs.addType")}
        action={createCertificationAction}
        openKeys={["newType", "create"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "text", name: "name", label: t("people.certs.typeName"), required: true },
          {
            kind: "text",
            name: "issuingBody",
            label: t("people.certs.issuingBody"),
            required: true,
          },
        ]}
      />
    );
  }

  let body;
  if (holders.length === 0) {
    body = (
      <EmptyStateLink
        icon="BadgeCheck"
        sentence={
          canVerify
            ? certs.length === 0
              ? t("people.certs.emptyNoTypes")
              : t("people.certs.emptyWriter")
            : t("people.certs.emptyReader")
        }
        actionLabel={
          canVerify
            ? certs.length === 0
              ? t("people.certs.addType")
              : t("people.certs.record")
            : t("people.certs.goDirectory")
        }
        href={
          canVerify
            ? withParams(base, search, certs.length === 0 ? { newType: "1" } : { create: "1" })
            : `/${crew.slug}/people/directory`
        }
      />
    );
  } else if (view === "calendar") {
    body = (
      <PeekCalendar
        month={`${(search["month"] ?? today).slice(0, 7)}-01`}
        today={today}
        events={holders.flatMap((h) =>
          h.expiresOn
            ? [
                {
                  id: h.id,
                  date: h.expiresOn,
                  label: t("people.certs.expiresEvent", {
                    name: name(h),
                    certification: h.certificationName,
                  }),
                  state: peopleStateIcon("certificate", status(h)),
                },
              ]
            : [],
        )}
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("people.certs.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {holders.map((h) => (
          <li key={h.id}>
            <Link
              href={withParams(base, search, { peek: h.id }) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">
                  {t("people.certs.title", { name: name(h), certification: h.certificationName })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {h.expiresOn
                    ? t("people.certs.expiresOn", { date: day(h.expiresOn) })
                    : t("people.certs.noExpiry")}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`people.certs.status.${status(h)}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("people.certs.caption")}
        columns={[
          { key: "person", label: t("crew.fields.person") },
          { key: "certification", label: t("people.certs.certification") },
          { key: "issued", label: t("people.certs.issued") },
          { key: "expires", label: t("people.certs.expires") },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={holders.map((h) => ({
          id: h.id,
          person: name(h),
          certification: h.certificationName,
          issued: day(h.issuedOn),
          expires: h.expiresOn ? day(h.expiresOn) : t("people.certs.noExpiry"),
          state: {
            state: peopleStateIcon("certificate", status(h)),
            label: t(`people.certs.status.${status(h)}`),
          },
        }))}
      />
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="people"
      params={routeParams}
      search={search}
      count={holders.length}
      view={view}
      {...(canVerify
        ? {
            actions: (
              <div className="flex flex-wrap gap-8">
                <ButtonLink href={withParams(base, search, { newType: "1" })} size="sm">
                  {t("people.certs.addType")}
                </ButtonLink>
                {certs.length > 0 ? (
                  <ButtonLink
                    href={withParams(base, search, { create: "1" })}
                    variant="primary"
                    size="sm"
                  >
                    {t("people.certs.record")}
                  </ButtonLink>
                ) : null}
              </div>
            ),
          }
        : {})}
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {expiring > 0 ? (
        <InlineAlert tone="warning" title={t("people.certs.expiringTitle", { count: expiring })}>
          {t("people.certs.expiringBody")}
        </InlineAlert>
      ) : null}
      {body}
    </CrewFrame>
  );
}
