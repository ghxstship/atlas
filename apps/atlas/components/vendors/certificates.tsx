import { listCurrencies } from "@xos/data/procurement";
import {
  certificateStanding,
  listInsuranceCertificates,
  listVendors,
  type CertificateStanding,
  type InsuranceCertificate,
} from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  createCertificateAction,
  deleteCertificateAction,
  updateCertificateAction,
} from "@/app/[org]/vendors/actions";
import { CertificateExtraction } from "@/components/aurora/certificate-extraction";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { CertificateInsureds, RequiredInsureds } from "@/components/vendors/insureds";
import { emptyFor } from "@/components/collection-kit/empty";
import {
  ActionButton,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  PeekDrawer,
  RecordPage,
  type FieldSpec,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { Money, PageHeader } from "@/components/collection-kit/ui";
import { minorToInput } from "@/lib/collection-kit/forms";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import {
  collectionState,
  formatMinor,
  toMajor,
  withQuery,
  type SearchParams,
} from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";

const VIEWS: readonly ViewKind[] = ["table", "list", "calendar"];
const REFUSALS = "vendors.refusals";

const STANDING_STATE: Record<CertificateStanding, KitState["state"]> = {
  current: "active",
  expiring: "blocked",
  expired: "canceled",
  future: "scheduled",
};

function standingOf(c: InsuranceCertificate, t: Copy, now: string): KitState {
  const s = certificateStanding(c, now);
  return { state: STANDING_STATE[s], label: t(`certificates.standing.${s}`) };
}

/**
 * Vendors > Insurance certificates: certificates of insurance on file, whether each is current
 * (derived from its validity window at read time), with a calendar of expiries. Recording needs
 * vendors.coi.write. The new-certificate drawer offers Aurora's extraction (journey 36): fields are
 * proposed with confidences and saved only when the person confirms.
 */
export async function InsuranceCertificates({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, certs, vendors, currencies] = await Promise.all([
    getCopy("vendors"),
    getFormatter(),
    listInsuranceCertificates(db, ctx.org.id),
    listVendors(db, ctx.org.id),
    listCurrencies(db),
  ]);
  const title = t("certificates.title");
  if (!certs.ok || !vendors.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("certificates.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("vendors.coi.write");
  const exponent = new Map(
    (currencies.ok ? currencies.data : []).map((c) => [c.code, c.minorUnits]),
  );
  const now = await orgToday(ctx);
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00`), { dateStyle: "medium" });
  const fields = (c?: InsuranceCertificate): FieldSpec[] => [
    {
      kind: "select",
      name: "vendorId",
      label: t("fields.vendor"),
      blankLabel: t("fields.chooseVendor"),
      defaultValue: c?.vendorId ?? (typeof search["vendor"] === "string" ? search["vendor"] : ""),
      options: vendors.data.map((v) => ({ value: v.id, label: v.name ?? t("directory.unnamed") })),
    },
    {
      kind: "text",
      name: "insurer",
      label: t("certificates.insurer"),
      required: true,
      defaultValue: c?.insurer ?? "",
    },
    {
      kind: "text",
      name: "policyIdentifier",
      label: t("certificates.policy"),
      required: true,
      defaultValue: c?.policyIdentifier ?? "",
    },
    {
      kind: "text",
      name: "coverageType",
      label: t("certificates.coverage"),
      required: true,
      help: t("certificates.coverageHelp"),
      defaultValue: c?.coverageType ?? "",
    },
    {
      kind: "money",
      name: "coverageLimit",
      label: t("certificates.limit"),
      defaultValue: c
        ? minorToInput(c.coverageLimitMinor, exponent.get(c.currencyCode ?? "") ?? 2)
        : "",
    },
    {
      kind: "select",
      name: "currencyCode",
      label: t("fields.currency"),
      blankLabel: t("directory.noCurrency"),
      defaultValue: c?.currencyCode ?? "",
      options: (currencies.ok ? currencies.data : []).map((x) => ({
        value: x.code,
        label: x.code,
      })),
    },
    {
      kind: "date",
      name: "validFrom",
      label: t("certificates.validFrom"),
      required: true,
      defaultValue: c?.validFrom ?? "",
    },
    {
      kind: "date",
      name: "validTo",
      label: t("certificates.validTo"),
      required: true,
      defaultValue: c?.validTo ?? "",
    },
    {
      kind: "url",
      name: "documentUri",
      label: t("certificates.document"),
      help: t("certificates.documentHelp"),
      defaultValue: c?.documentUri ?? "",
    },
  ];
  const selected = state.peek ? certs.data.find((c) => c.id === state.peek) : undefined;
  const limit = (c: InsuranceCertificate) => (
    <Money
      amount={toMajor(c.coverageLimitMinor, exponent.get(c.currencyCode ?? "") ?? 2)}
      {...(c.currencyCode ? { currency: c.currencyCode } : {})}
      unpricedLabel={t("certificates.noLimit")}
    />
  );
  const properties = (c: InsuranceCertificate) => [
    { label: t("fields.vendor"), value: c.vendorName ?? t("directory.unnamed") },
    { label: t("certificates.insurer"), value: c.insurer },
    { label: t("certificates.policy"), value: c.policyIdentifier },
    { label: t("certificates.limit"), value: limit(c) },
    { label: t("certificates.validFrom"), value: date(c.validFrom) },
    { label: t("certificates.validTo"), value: date(c.validTo) },
    { label: t("certificates.document"), value: c.documentUri ?? t("certificates.noDocument") },
  ];
  const controls = (c: InsuranceCertificate) =>
    canWrite ? (
      <ActionButton
        action={deleteCertificateAction}
        hidden={{ org: ctx.org.slug, id: c.id }}
        label={t("certificates.delete")}
        variant="danger"
        confirm={{ title: t("certificates.deleteTitle"), body: t("certificates.deleteBody") }}
        refusals={REFUSALS}
      />
    ) : null;
  const editForm = (c: InsuranceCertificate) =>
    canWrite ? (
      <EntityForm
        id={`coi-edit-${c.id}`}
        action={updateCertificateAction}
        hidden={{ org: ctx.org.slug, id: c.id }}
        refusals={REFUSALS}
        submitLabel={t("certificates.save")}
        fields={fields(c)}
      />
    ) : null;

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("certificates.back")}
        recordKey={selected.policyIdentifier}
        title={`${selected.coverageType} · ${selected.vendorName ?? t("directory.unnamed")}`}
        state={standingOf(selected, t, now)}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        <CertificateInsureds ctx={ctx} certificateId={selected.id} />
        {editForm(selected)}
        <CollabPanels ctx={ctx} table="app.insurance_certificates" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = certs.data.map((c) => ({
    id: c.id,
    key: c.policyIdentifier,
    title: `${c.coverageType} · ${c.vendorName ?? t("directory.unnamed")}`,
    state: standingOf(c, t, now),
    date: c.validTo,
    meta: t("certificates.until", { date: date(c.validTo) }),
    cells: {
      vendor: c.vendorName,
      coverage: c.coverageType,
      insurer: c.insurer,
      limit: formatMinor(
        format,
        c.coverageLimitMinor,
        c.currencyCode,
        exponent.get(c.currencyCode ?? "") ?? 2,
        t("certificates.noLimit"),
      ),
      validTo: date(c.validTo),
      standing: standingOf(c, t, now),
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("certificates.create")} closeHref={withQuery(path, state)}>
        <CertificateExtraction
          vendors={vendors.data.map((v) => ({
            value: v.id,
            label: v.name ?? t("directory.unnamed"),
          }))}
        />
        <EntityForm
          id="coi-create"
          action={createCertificateAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("certificates.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={fields()}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.policyIdentifier}
        title={`${selected.coverageType} · ${selected.vendorName ?? t("directory.unnamed")}`}
        state={standingOf(selected, t, now)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        <CertificateInsureds ctx={ctx} certificateId={selected.id} />
      </PeekDrawer>
    );
  } else if (search["required"] === "1") {
    drawer = (
      <FormDrawer title={t("insureds.requiredTitle")} closeHref={withQuery(path, state)}>
        <RequiredInsureds ctx={ctx} />
      </FormDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      month={state.month}
      columns={[
        { key: "vendor", label: t("fields.vendor") },
        { key: "coverage", label: t("certificates.coverage") },
        { key: "insurer", label: t("certificates.insurer") },
        { key: "limit", label: t("certificates.limit") },
        { key: "validTo", label: t("certificates.validTo") },
        { key: "standing", label: t("certificates.standingLabel"), type: "state" },
      ]}
      rows={rows}
      actions={
        <>
          <KitLink href={withQuery(path, state, { required: "1" })}>
            {t("insureds.requiredTitle")}
          </KitLink>
          {canWrite ? (
            <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
              {t("certificates.create")}
            </KitLink>
          ) : null}
        </>
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "certificates")}
    >
      {drawer}
    </CollectionView>
  );
}
