import {
  getVendor,
  listCounterpartiesWithoutVendor,
  listInsuranceCertificates,
  listPrequalifications,
  listScorecards,
  listTransitionRules,
  listVendorBankAccounts,
  listVendorClasses,
  listVendors,
  certificateStanding,
  scorecardAverage,
  type Vendor,
  type VendorState,
} from "@xos/data/vendors";
import { listCurrencies, listVendorProducts } from "@xos/data/procurement";
import { nextStates } from "@xos/data/commercial-common";
import { getFormatter } from "next-intl/server";
import { vendorBulk } from "@/lib/bulk/procurement";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import {
  addBankAccountAction,
  createVendorAction,
  transitionVendorAction,
  updateVendorAction,
} from "@/app/[org]/vendors/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { StateHistory } from "@/components/collection-kit/history";
import {
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
  TransitionButtons,
} from "@/components/collection-kit/kit";
import { recordStateOf, type KitRow, type ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { PresenceFor } from "@/components/presence/presence-for";
import { orgToday } from "@/lib/shell/time-zone";
import { EmptyStateLink } from "@/components/ui";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list", "gallery"];
const REFUSALS = "vendors.refusals";

/**
 * Vendors > Directory (Section 4.2 Vendors): every vendor of the org with its lifecycle, terms and
 * classes. The peek shows the vendor and its moves; the full page adds terms and classes editing,
 * masked bank accounts, compliance on file, scorecards, products, history, comments and files.
 */
export async function VendorDirectory({
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
  const [t, vendors, classes, rules] = await Promise.all([
    getCopy("vendors"),
    listVendors(db, ctx.org.id),
    listVendorClasses(db, ctx.org.id),
    listTransitionRules<VendorState>(db, "vendor"),
  ]);
  const title = t("directory.title");
  if (!vendors.ok || !classes.ok || !rules.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("directory.what")} />
      </CollectionPage>
    );
  }
  const canWrite = ctx.capabilities.has("vendors.vendor.write");
  const className = new Map(classes.data.map((c) => [c.id, c.name]));
  const stateLabel = (s: string) => t(`states.${s}`);

  if (state.peek && state.full) {
    return (
      <VendorRecord
        ctx={ctx}
        path={path}
        id={state.peek}
        backHref={withQuery(path, state)}
        canWrite={canWrite}
        rules={rules.data}
      />
    );
  }

  const rows: KitRow[] = vendors.data.map((v) => ({
    id: v.id,
    key: v.counterpartyType ?? t("directory.untyped"),
    title: v.name ?? t("directory.unnamed"),
    label: v.name ?? t("directory.unnamed"),
    state: { state: recordStateOf(v.state), label: stateLabel(v.state) },
    meta: v.classIds
      .map((c) => className.get(c))
      .filter(Boolean)
      .join(", "),
    cells: {
      name: v.name ?? t("directory.unnamed"),
      type: v.counterpartyType,
      state: { state: recordStateOf(v.state), label: stateLabel(v.state) },
      terms:
        v.paymentTermsDays === null ? null : t("directory.termsDays", { days: v.paymentTermsDays }),
      currency: v.defaultCurrencyCode,
      classes: v.classIds
        .map((c) => className.get(c))
        .filter(Boolean)
        .join(", "),
    },
  }));

  // Bulk edit (Section 11.7): state, payment terms and default currency across a selection.
  const currencies = canWrite ? await listCurrencies(db) : null;
  const bulk = vendorBulk(ctx.org.slug, ctx.capabilities, t, {
    currencies: currencies?.ok ? currencies.data.map((c) => c.code) : [],
    terms: vendors.data.map((v) => v.paymentTermsDays),
  });

  let drawer = null;
  if (state.create && canWrite) {
    drawer = <CreateVendor ctx={ctx} closeHref={withQuery(path, state)} path={path} />;
  } else if (state.peek) {
    const vendor = vendors.data.find((v) => v.id === state.peek);
    if (vendor) {
      drawer = (
        <PeekDrawer
          recordKey={vendor.counterpartyType ?? t("directory.untyped")}
          title={vendor.name ?? t("directory.unnamed")}
          state={{ state: recordStateOf(vendor.state), label: stateLabel(vendor.state) }}
          closeHref={withQuery(path, state)}
          fullHref={withQuery(path, state, { peek: vendor.id, full: "1" })}
          properties={vendorProperties(vendor, t, className)}
          actions={
            canWrite ? (
              <TransitionButtons
                action={transitionVendorAction}
                org={ctx.org.slug}
                id={vendor.id}
                expected={vendor.state}
                refusals={REFUSALS}
                moves={nextStates(rules.data, vendor.state).map((next) => ({
                  next,
                  label: t(`moves.${next}`),
                  danger: next === "Blocked" || next === "Canceled",
                }))}
              />
            ) : null
          }
        >
          <PresenceFor table="vendors" id={vendor.id} />
        </PeekDrawer>
      );
    }
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "name", label: t("fields.name") },
        { key: "type", label: t("fields.counterpartyType") },
        { key: "state", label: t("fields.state"), type: "state" },
        { key: "terms", label: t("fields.paymentTerms") },
        { key: "currency", label: t("fields.currency"), type: "code" },
        { key: "classes", label: t("fields.classes"), wrap: true },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("directory.create")}
          </KitLink>
        ) : null
      }
      empty={
        canWrite ? (
          <EmptyStateLink
            icon="Building2"
            sentence={t("directory.empty")}
            actionLabel={t("directory.create")}
            href={withQuery(path, state, { create: "1" })}
          />
        ) : (
          <EmptyRefresh icon="Building2" sentence={t("directory.emptyRead")} />
        )
      }
      bulk={bulk}
    >
      {drawer}
    </CollectionView>
  );
}

type T = Copy;

function vendorProperties(vendor: Vendor, t: T, className: Map<string, string>) {
  return [
    {
      label: t("fields.counterpartyType"),
      value: vendor.counterpartyType ?? t("directory.untyped"),
    },
    {
      label: t("fields.paymentTerms"),
      value:
        vendor.paymentTermsDays === null
          ? t("directory.noTerms")
          : t("directory.termsDays", { days: vendor.paymentTermsDays }),
    },
    { label: t("fields.currency"), value: vendor.defaultCurrencyCode ?? t("directory.noCurrency") },
    {
      label: t("fields.classes"),
      value:
        vendor.classIds
          .map((c) => className.get(c))
          .filter(Boolean)
          .join(", ") || t("directory.noClasses"),
    },
  ];
}

async function CreateVendor({
  ctx,
  closeHref,
  path,
}: {
  ctx: OrgContext;
  closeHref: string;
  path: string;
}) {
  const db = ctx.viewer.db;
  const [t, free, types, currencies] = await Promise.all([
    getCopy("vendors"),
    listCounterpartiesWithoutVendor(db, ctx.org.id),
    db
      .schema("xpms")
      .from("dim_counterparty_type")
      .select("counterparty_type")
      .order("counterparty_type"),
    listCurrencies(db),
  ]);
  return (
    <FormDrawer title={t("directory.create")} closeHref={closeHref}>
      <p className="m-0 text-text-13 text-text-secondary">{t("directory.createHelp")}</p>
      <EntityForm
        id="vendor-create"
        action={createVendorAction}
        hidden={{ org: ctx.org.slug }}
        refusals={REFUSALS}
        submitLabel={t("directory.create")}
        successHref={`${path}?peek={id}`}
        fields={[
          {
            kind: "select",
            name: "counterpartyId",
            label: t("fields.existingCompany"),
            help: t("directory.existingHelp"),
            blankLabel: t("directory.newCompany"),
            defaultValue: "",
            options: (free.ok ? free.data : []).map((c) => ({
              value: c.id,
              label: c.name ?? t("directory.unnamed"),
            })),
          },
          { kind: "text", name: "name", label: t("fields.name"), help: t("directory.nameHelp") },
          {
            kind: "select",
            name: "counterpartyType",
            label: t("fields.counterpartyType"),
            blankLabel: t("directory.untyped"),
            defaultValue: "",
            options: (types.data ?? []).map((r) => ({
              value: r.counterparty_type,
              label: r.counterparty_type,
            })),
          },
          { kind: "number", name: "paymentTermsDays", label: t("fields.paymentTermsDays") },
          {
            kind: "select",
            name: "defaultCurrencyCode",
            label: t("fields.currency"),
            blankLabel: t("directory.noCurrency"),
            defaultValue: "",
            options: (currencies.ok ? currencies.data : []).map((c) => ({
              value: c.code,
              label: c.code,
            })),
          },
        ]}
      />
    </FormDrawer>
  );
}

async function VendorRecord({
  ctx,
  path,
  id,
  backHref,
  canWrite,
  rules,
}: {
  ctx: OrgContext;
  path: string;
  id: string;
  backHref: string;
  canWrite: boolean;
  rules: readonly { from: VendorState; to: VendorState }[];
}) {
  const db = ctx.viewer.db;
  const [t, format, vendor, classes, banks, certs, prequals, scores, products, currencies] =
    await Promise.all([
      getCopy("vendors"),
      getFormatter(),
      getVendor(db, id),
      listVendorClasses(db, ctx.org.id),
      listVendorBankAccounts(db, id),
      listInsuranceCertificates(db, ctx.org.id, id),
      listPrequalifications(db, ctx.org.id, id),
      listScorecards(db, ctx.org.id, id),
      listVendorProducts(db, { vendorId: id }),
      listCurrencies(db),
    ]);
  if (!vendor.ok) {
    return vendor.error.kind === "not-found" ? (
      <EmptyStateLink
        icon="SearchX"
        sentence={t("directory.gone")}
        actionLabel={t("directory.back")}
        href={backHref}
      />
    ) : (
      <ErrorPanel what={t("directory.what")} />
    );
  }
  const v = vendor.data;
  const className = new Map((classes.ok ? classes.data : []).map((c) => [c.id, c.name]));
  const stateLabel = (s: string) => t(`states.${s}`);
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00`), { dateStyle: "medium" });
  const now = await orgToday(ctx);
  return (
    <RecordPage
      backHref={backHref}
      backLabel={t("directory.back")}
      recordKey={v.counterpartyType ?? t("directory.untyped")}
      title={v.name ?? t("directory.unnamed")}
      state={{ state: recordStateOf(v.state), label: stateLabel(v.state) }}
      properties={vendorProperties(v, t, className)}
      actions={
        canWrite ? (
          <TransitionButtons
            action={transitionVendorAction}
            org={ctx.org.slug}
            id={v.id}
            expected={v.state}
            refusals={REFUSALS}
            moves={nextStates(rules, v.state).map((next) => ({
              next,
              label: t(`moves.${next}`),
              danger: next === "Blocked" || next === "Canceled",
            }))}
          />
        ) : null
      }
    >
      <PresenceFor table="vendors" id={v.id} />
      {canWrite ? (
        <KitSection id="vendor-terms" title={t("directory.terms")}>
          <EntityForm
            id="vendor-edit"
            action={updateVendorAction}
            hidden={{ org: ctx.org.slug, id: v.id, classesShown: "1" }}
            refusals={REFUSALS}
            submitLabel={t("directory.save")}
            fields={[
              {
                kind: "number",
                name: "paymentTermsDays",
                label: t("fields.paymentTermsDays"),
                defaultValue: v.paymentTermsDays === null ? "" : String(v.paymentTermsDays),
              },
              {
                kind: "select",
                name: "defaultCurrencyCode",
                label: t("fields.currency"),
                blankLabel: t("directory.noCurrency"),
                defaultValue: v.defaultCurrencyCode ?? "",
                options: (currencies.ok ? currencies.data : []).map((c) => ({
                  value: c.code,
                  label: c.code,
                })),
              },
              {
                kind: "checkboxes",
                name: "classIds",
                label: t("fields.classes"),
                help: t("directory.noClassesYet"),
                defaultValues: [...v.classIds],
                options: (classes.ok ? classes.data : []).map((c) => ({
                  value: c.id,
                  label: c.name,
                })),
              },
            ]}
          />
        </KitSection>
      ) : null}

      <KitSection id="vendor-banks" title={t("bank.title")}>
        {!banks.ok ? (
          <ErrorPanel what={t("bank.title")} />
        ) : banks.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("bank.empty")}</p>
        ) : (
          <DataTable
            caption={t("bank.title")}
            columns={[
              { key: "bank", label: t("bank.bankName") },
              { key: "holder", label: t("bank.holder") },
              { key: "number", label: t("bank.number"), type: "code" },
              { key: "routing", label: t("bank.routing"), type: "code" },
            ]}
            rows={banks.data.map((b) => ({
              bank: b.bankName,
              holder: b.accountHolder,
              number: b.isMasked ? t("bank.masked", { last4: b.accountLast4 }) : b.accountNumber,
              routing: b.isMasked ? t("bank.maskedShort") : b.routingNumber,
            }))}
          />
        )}
        {ctx.capabilities.has("vendors.bank_details.write") ? (
          <EntityForm
            id="vendor-bank-add"
            action={addBankAccountAction}
            hidden={{ org: ctx.org.slug, vendorId: v.id }}
            refusals={REFUSALS}
            submitLabel={t("bank.add")}
            fields={[
              { kind: "text", name: "bankName", label: t("bank.bankName"), required: true },
              { kind: "text", name: "accountHolder", label: t("bank.holder"), required: true },
              {
                kind: "text",
                name: "accountNumber",
                label: t("bank.number"),
                required: true,
                help: t("bank.numberHelp"),
              },
              { kind: "text", name: "routingNumber", label: t("bank.routing") },
            ]}
          />
        ) : null}
      </KitSection>

      <KitSection
        id="vendor-compliance"
        title={t("directory.compliance")}
        actions={
          <KitLink
            href={`${path.replace(/directory$/, "insurance-certificates")}?create=1&vendor=${v.id}`}
            size="sm"
          >
            {t("certificates.create")}
          </KitLink>
        }
      >
        {!certs.ok || !prequals.ok ? (
          <ErrorPanel what={t("directory.compliance")} />
        ) : certs.data.length === 0 && prequals.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("directory.noCompliance")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {certs.data.map((c) => (
              <li key={c.id}>
                {t("directory.certificateLine", {
                  coverage: c.coverageType,
                  insurer: c.insurer,
                  until: date(c.validTo),
                  standing: t(`certificates.standing.${certificateStanding(c, now)}`),
                })}
              </li>
            ))}
            {prequals.data.map((q) => (
              <li key={q.id}>
                {t("directory.prequalLine", {
                  scope: q.scopeNote,
                  decision: t(`prequalification.decision.${q.decision ?? "Pending"}`),
                })}
              </li>
            ))}
          </ul>
        )}
      </KitSection>

      <KitSection id="vendor-scores" title={t("scorecards.title")}>
        {!scores.ok ? (
          <ErrorPanel what={t("scorecards.title")} />
        ) : scores.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("scorecards.emptyVendor")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {scores.data.map((s) => {
              const avg = scorecardAverage(s);
              return (
                <li key={s.id}>
                  {t("directory.scoreLine", {
                    period: date(s.periodEnd),
                    average: avg === null ? t("scorecards.unscored") : String(avg),
                  })}
                </li>
              );
            })}
          </ul>
        )}
      </KitSection>

      <KitSection id="vendor-products" title={t("directory.products")}>
        {!products.ok ? (
          <ErrorPanel what={t("directory.products")} />
        ) : products.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("directory.noProducts")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {products.data.map((p) => (
              <li key={p.id} className="font-mono">
                {p.vendorSku}
              </li>
            ))}
          </ul>
        )}
      </KitSection>

      <StateHistory ctx={ctx} ledger="vendor" id={v.id} stateLabel={stateLabel} />
      <CollabPanels ctx={ctx} table="app.vendors" id={v.id} />
    </RecordPage>
  );
}
