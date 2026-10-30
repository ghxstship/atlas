import type { XosClient } from "@xos/data";
import type { AssetUnitDetail } from "@xos/data/assets";
import { assetStateKey, getAssetUnitProvenance, scanActionsFor } from "@xos/data/assets";
import { getPurchaseOrder } from "@xos/data/procurement";
import { Tag } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { Money, PropertyList, StateIcon, TemplateRecord } from "@/components/assets/ui";
import { custodianName, type AssetCapabilities, type AssetPickers } from "@/lib/assets/context";
import { majorUnits } from "@/lib/assets/money";
import { ASSET_STATE_TONE } from "@/lib/assets/views";
import type { Translate } from "@/lib/shell/translate";
import { AssetCollab } from "./collab";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { AddIdentifier, RemoveIdentifier, UnitActions } from "./unit-actions";

/**
 * One asset unit in the Record template (Section 11.6): title row with tag, class and state; custody,
 * state history, maintenance, damage and identifiers on the left; properties in the 320 px column.
 * The same content fills the side peek (compact) and the full page.
 */
export async function UnitRecord({
  org,
  unit,
  pickers,
  can,
  currency,
  today,
  t,
  db,
  me,
  compact = false,
}: {
  db: XosClient;
  me: string | null;
  org: string;
  unit: AssetUnitDetail;
  pickers: AssetPickers;
  can: AssetCapabilities;
  currency: string;
  today: string;
  t: Translate;
  compact?: boolean;
}) {
  const format = await getFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const stateLabel = (s: AssetUnitDetail["state"]) => t(`assets.states.${assetStateKey(s)}`);
  const condition = pickers.conditions.find((c) => c.value === unit.conditionEnumId)?.label;
  const custodian = unit.custody
    ? (custodianName(pickers, unit.custody) ??
      unit.custody.venueName ??
      t("assets.common.notRecorded"))
    : t("assets.units.noCustody");
  // Returned is reached only through a return on the unit's order (R7a), never from this dialog.
  const next = (pickers.transitions.get(unit.state) ?? [])
    .filter((s) => s !== "Returned")
    .filter((s) => s !== "Retired" || can.writeOff)
    .map((s) => ({ value: s, label: stateLabel(s) }));

  const properties = (
    <PropertyList
      items={[
        { label: t("assets.fields.classId"), value: unit.className },
        {
          label: t("assets.fields.elementId"),
          value: <span className="font-mono text-text-12">{unit.elementId ?? ""}</span>,
        },
        {
          label: t("assets.fields.state"),
          value: (
            <span className="inline-flex items-center gap-6">
              <StateIcon state={ASSET_STATE_TONE[unit.state]} />
              {stateLabel(unit.state)}
            </span>
          ),
        },
        {
          label: t("assets.fields.conditionEnumId"),
          value: condition ?? t("assets.common.notRecorded"),
        },
        {
          label: t("assets.fields.homeVenueId"),
          value: unit.homeVenueName ?? t("assets.common.noVenue"),
        },
        { label: t("assets.fields.custodian"), value: custodian },
        {
          label: t("assets.fields.projectId"),
          value: unit.custody?.projectKey ?? t("assets.common.noProject"),
        },
        {
          label: t("assets.fields.since"),
          value: unit.custody ? when(unit.custody.since) : t("assets.common.notRecorded"),
        },
        { label: t("assets.fields.createdAt"), value: when(unit.createdAt) },
      ]}
    />
  );

  const header = (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8">
        <h2 className="m-0 text-heading-20 font-semibold">
          <span className="font-mono">{unit.assetTag}</span> · {unit.className}
        </h2>
        <span className="inline-flex items-center gap-6 text-text-13 text-text-secondary">
          <StateIcon state={ASSET_STATE_TONE[unit.state]} />
          {stateLabel(unit.state)}
        </span>
      </div>
      <UnitActions
        org={org}
        unitId={unit.id}
        assetTag={unit.assetTag}
        state={unit.state}
        conditionEnumId={unit.conditionEnumId}
        homeVenueId={unit.homeVenueId}
        custodyProjectId={unit.custody?.projectId ?? null}
        nextStates={next}
        scanActions={scanActionsFor(unit.state)}
        conditions={pickers.conditions}
        pickers={{
          members: pickers.members,
          engagements: pickers.engagements,
          projects: pickers.projects,
          venues: pickers.venues,
        }}
        currency={currency}
        today={today}
        can={can}
      />
    </div>
  );

  const provenance = await Provenance({ db, org, unitId: unit.id, t, when });

  const content = (
    <>
      {provenance}
      <Section title={t("assets.units.sections.custody")}>
        {unit.custodyHistory.length === 0 ? (
          <Empty>{t("assets.units.none.custody")}</Empty>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {unit.custodyHistory.map((c) => (
              <li key={c.custodyId} className="flex flex-col gap-2 text-text-13">
                <span className="font-medium">
                  {custodianName(pickers, c) ?? c.venueName ?? t("assets.common.notRecorded")}
                  {c.projectKey ? ` · ${c.projectKey}` : ""}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {when(c.since)}
                  {c.note ? ` · ${c.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title={t("assets.units.sections.history")}>
        <ol className="m-0 flex list-none flex-col gap-8 p-0">
          {unit.transitions.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 text-text-13">
              <span className="font-medium">
                {s.fromState
                  ? t("assets.units.moved", {
                      from: stateLabel(s.fromState),
                      to: stateLabel(s.toState),
                    })
                  : t("assets.units.registered", { state: stateLabel(s.toState) })}
              </span>
              <span className="text-text-12 text-text-secondary">
                {when(s.at)}
                {s.reason ? ` · ${s.reason}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title={t("assets.units.sections.maintenance")}>
        {unit.maintenance.length === 0 ? (
          <Empty>{t("assets.units.none.maintenance")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {unit.maintenance.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 text-text-13">
                <span className="font-medium">{m.description}</span>
                <span className="text-text-12 text-text-secondary">
                  {day(m.performedOn)} ·{" "}
                  <Money
                    amount={majorUnits(m.costMinor, m.currencyCode)}
                    {...(m.currencyCode ? { currency: m.currencyCode } : {})}
                    unpricedLabel={t("assets.common.costUnknown")}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("assets.units.sections.damage")}>
        {unit.damage.length === 0 ? (
          <Empty>{t("assets.units.none.damage")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {unit.damage.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 text-text-13">
                <span className="font-medium">{d.description}</span>
                <span className="text-text-12 text-text-secondary">
                  {when(d.reportedAt)}
                  {d.projectKey ? ` · ${d.projectKey}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section
        title={t("assets.units.sections.identifiers")}
        action={can.write ? <AddIdentifier org={org} unitId={unit.id} /> : null}
      >
        {unit.identifiers.length === 0 ? (
          <Empty>{t("assets.units.none.identifiers")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {unit.identifiers.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-8 text-text-13">
                <span>
                  <span className="text-text-secondary">{i.scheme}</span>{" "}
                  <span className="font-mono">{i.value}</span>
                </span>
                {can.write ? (
                  <RemoveIdentifier
                    org={org}
                    identifierId={i.id}
                    label={`${i.scheme} ${i.value}`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <CustomFieldsPanel org={org} table="app.asset_units" id={unit.id} />
      <AssetCollab db={db} org={org} table="app.asset_units" id={unit.id} me={me} />
    </>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-16">
        {header}
        {properties}
        {content}
      </div>
    );
  }
  return (
    <TemplateRecord
      header={header}
      properties={properties}
      propertiesLabel={t("assets.units.properties")}
    >
      {content}
    </TemplateRecord>
  );
}

/**
 * Where the unit came from (R7a): the order it arrived on, the vendor, when it was received and, for a hire, when
 * it goes back. app.asset_unit_provenance runs as the reader, so the section is left out for anyone who cannot
 * read the order (procurement.po.read) and cost never reaches an asset-only reader.
 */
async function Provenance({
  db,
  org,
  unitId,
  t,
  when,
}: {
  db: XosClient;
  org: string;
  unitId: string;
  t: Translate;
  when: (iso: string) => string;
}) {
  const provenance = await getAssetUnitProvenance(db, unitId);
  if (!provenance.ok || provenance.data === null) return null;
  const p = provenance.data;
  const order = await getPurchaseOrder(db, p.purchaseOrderId);
  const orderLabel = order.ok ? order.data.key : t("assets.provenance.order");
  return (
    <Section title={t("assets.provenance.title")}>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-12 gap-y-4 text-text-13">
        <dt className="text-text-secondary">{t("assets.provenance.order")}</dt>
        <dd className="m-0">
          <Link
            href={`/${org}/procurement/purchase-orders?peek=${p.purchaseOrderId}&full=1` as Route}
            className="font-mono text-accent-text underline"
          >
            {orderLabel}
          </Link>
          {p.acquisitionKind === "Rental" ? (
            <span className="ms-8">
              <Tag tone="accent">{t("assets.provenance.rental")}</Tag>
            </span>
          ) : null}
        </dd>
        <dt className="text-text-secondary">{t("assets.provenance.vendor")}</dt>
        <dd className="m-0">
          {(order.ok ? order.data.vendorName : null) ?? t("assets.common.notRecorded")}
        </dd>
        <dt className="text-text-secondary">{t("assets.provenance.receivedAt")}</dt>
        <dd className="m-0">{when(p.receivedAt)}</dd>
        {p.hireEndsAt ? (
          <>
            <dt className="text-text-secondary">{t("assets.provenance.hireEnds")}</dt>
            <dd className="m-0">{when(p.hireEndsAt)}</dd>
          </>
        ) : null}
      </dl>
    </Section>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-8">
        <h3 className="m-0 text-heading-14 font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}
