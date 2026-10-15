import {
  getCurrencyExponent,
  getRateCanon,
  listCurrencies,
  listPayRates,
  listRateCardLines,
  listRateCards,
  type PayRate,
  type RateCardLine,
} from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  addRateLineAction,
  createRateCardAction,
  recordPayRateAction,
  removeRateLineAction,
  saveRatesAction,
  trashRateCardAction,
  updateRateCardAction,
  updateRateLineAction,
} from "@/app/[org]/crew/actions";
import { ConfirmButton, DrawerForm, type FieldSpec } from "@/components/crew/forms";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { RateGrid } from "@/components/crew/rate-grid";
import { CrewRecord } from "@/components/crew/record";
import { InlineAlert, StateChip } from "@/components/crew/ui";
import { PeekTable } from "@/components/crew/views";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getMembers,
  getRoleTitles,
  withParams,
} from "@/lib/crew/context";
import { money } from "@/lib/crew/format";
import { fromMinor } from "@/lib/crew/money";
import { rateCardPhase, stateIcon } from "@/lib/crew/states";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Rate Cards (Section 4.5.5, Grid editor template): the org's labor rate cards with their lines
 * in the spreadsheet grid, and the append-only pay rate ledger. Lines name canon roles,
 * classifications, pay bases, arrangements and overtime rules, never retyped. Rates are Restricted:
 * without data.restricted.read.payroll they read Masked and the grid is read-only (journey 31).
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/rate-cards">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.rate-cards";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const today = new Date().toISOString().slice(0, 10);
  const [cardsResult, roles, canonResult] = await Promise.all([
    listRateCards(db, crew.orgId),
    getRoleTitles(crew.ctx),
    getRateCanon(db),
  ]);
  if (!cardsResult.ok) throw new Error(`Cannot list rate cards: ${cardsResult.error.kind}`);
  if (!canonResult.ok) throw new Error(`Cannot read rate canon: ${canonResult.error.kind}`);
  const cards = cardsResult.data;
  const canon = canonResult.data;
  const card = cards.find((c) => c.id === search["card"]) ?? cards[0] ?? null;
  const canWrite = crew.can("crew.rate_card.write");
  const canPay = crew.can("org.payroll.write");
  const linesResult = card ? await listRateCardLines(db, card.id) : null;
  if (linesResult && !linesResult.ok) throw new Error(`Cannot list rate card lines: ${linesResult.error.kind}`);
  const lines = linesResult?.ok ? linesResult.data : [];
  const masked = lines.some((l) => l.masked);
  const exponentResult = card ? await getCurrencyExponent(db, card.currencyCode) : null;
  const exponent = exponentResult?.ok ? exponentResult.data : 2;
  const ratesResult = await listPayRates(db, { orgId: crew.orgId });
  if (!ratesResult.ok) throw new Error(`Cannot list pay rates: ${ratesResult.error.kind}`);
  const rates = ratesResult.data;
  const roleName = (code: string) => `${code} · ${roles.get(code)?.title ?? code}`;
  const ruleName = (id: string) => canon.overtimeRules.find((r) => r.id === id)?.name ?? id;
  const className = (code: string) => canon.classifications.find((c) => c.code === code)?.label ?? code;
  const keep = { card: card?.id ?? null };

  // Peeks: a rate card line, or a pay rate entry (ids prefixed rate:).
  let peek = null;
  const peekId = search["peek"];
  if (peekId?.startsWith("rate:")) {
    const r = rates.find((x) => x.id === peekId.slice(5));
    if (r) {
      peek = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          kindLabel={t("crew.rates.payRate")}
          recordKey={r.currencyCode}
          title={t("crew.common.pair", { a: r.member.name ?? t("crew.common.unnamed"), b: roleName(r.roleCode) })}
          state="complete"
          stateLabel={t("crew.rates.inLedger")}
          backHref={withParams(base, search, { peek: null, full: null })}
          properties={[
            { label: t("crew.fields.person"), value: r.member.name ?? t("crew.common.unnamed") },
            { label: t("crew.fields.role"), value: roleName(r.roleCode) },
            { label: t("crew.rates.rate"), value: money(format, t, r.rateMinor, r.currencyCode, r.masked) },
            { label: t("crew.rates.effectiveFrom"), value: format.dateTime(new Date(`${r.effectiveFrom}T12:00:00Z`), { timeZone: "UTC", dateStyle: "medium" }) },
          ]}
        >
          <p className="m-0 text-text-12 text-text-secondary">{t("crew.rates.ledgerNote")}</p>
        </CrewRecord>
      );
      if (search["full"] === "1") return peek;
    }
  } else if (peekId && card) {
    const l = lines.find((x) => x.id === peekId);
    if (l) {
      peek = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          kindLabel={t("crew.rates.line")}
          recordKey={card.name}
          title={roleName(l.roleCode)}
          state={l.masked ? "proposed" : l.rateMinor === null ? "deferred" : "complete"}
          stateLabel={l.masked ? t("crew.money.masked") : l.rateMinor === null ? t("crew.money.unpriced") : t("crew.rates.priced")}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={
            canWrite ? (
              <>
                {!l.masked ? (
                  <ButtonLink href={withParams(base, search, { peek: null, editLine: l.id })} size="sm">
                    {t("crew.rates.editRate")}
                  </ButtonLink>
                ) : null}
                <ConfirmButton label={t("crew.rates.removeLine")} title={t("crew.rates.removeLineTitle")} defaultReason={t("crew.rates.removeLine")} reason={false} action={removeRateLineAction} hidden={{ org: crew.slug, id: l.id }} variant="danger" />
              </>
            ) : null
          }
          properties={[
            { label: t("crew.fields.role"), value: roleName(l.roleCode) },
            { label: t("crew.rates.classification"), value: className(l.workerClassification) },
            { label: t("crew.rates.payBasis"), value: l.payBasis },
            { label: t("crew.rates.arrangement"), value: l.arrangement },
            { label: t("crew.rates.overtime"), value: `${l.overtimeRuleId} · ${ruleName(l.overtimeRuleId)}` },
            { label: t("crew.rates.canonCard"), value: l.canonRateCardId ?? t("crew.rates.notAdopted") },
            { label: t("crew.rates.rate"), value: money(format, t, l.rateMinor, card.currencyCode, l.masked) },
          ]}
        />
      );
      if (search["full"] === "1") return peek;
    }
  }

  // Drawers.
  const currencies = search["create"] === "1" ? await listCurrencies(db) : null;
  const members = search["payRate"] === "1" ? await getMembers(crew.ctx) : [];
  const roleOptions = [...roles.values()].map((r) => ({ value: r.code, label: `${r.code} · ${r.title}` }));
  const cardFields = (c: typeof card): FieldSpec[] => [
    { kind: "hidden", name: "org", value: crew.slug },
    ...(c ? [{ kind: "hidden" as const, name: "id", value: c.id }] : []),
    { kind: "text", name: "name", label: t("crew.rates.name"), value: c?.name ?? "", required: true },
    ...(c
      ? []
      : [{ kind: "select" as const, name: "currencyCode", label: t("crew.rates.currency"), value: "USD", options: (currencies?.ok ? currencies.data : ["USD"]).map((x) => ({ value: x, label: x })) }]),
    { kind: "date", name: "effectiveFrom", label: t("crew.rates.effectiveFrom"), value: c?.effectiveFrom ?? today, required: true },
    { kind: "date", name: "effectiveTo", label: t("crew.rates.effectiveTo"), value: c?.effectiveTo ?? "", help: t("crew.rates.effectiveToHelp") },
  ];
  const editLine: RateCardLine | undefined = search["editLine"] ? lines.find((l) => l.id === search["editLine"]) : undefined;
  let drawer = null;
  if (search["create"] === "1" && canWrite) {
    drawer = <DrawerForm title={t("crew.rates.createTitle")} submitLabel={t("crew.rates.create")} action={createRateCardAction} fields={cardFields(null)} />;
  } else if (search["edit"] === "1" && canWrite && card) {
    drawer = <DrawerForm title={t("crew.rates.editTitle")} submitLabel={t("crew.common.save")} action={updateRateCardAction} fields={cardFields(card)} openKeys={["edit"]} />;
  } else if (search["addLine"] === "1" && canWrite && card) {
    const classes = canon.classifications;
    drawer = (
      <DrawerForm
        title={t("crew.rates.addLineTitle")}
        submitLabel={t("crew.rates.addLine")}
        action={addRateLineAction}
        openKeys={["addLine"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "rateCardId", value: card.id },
          { kind: "hidden", name: "currencyCode", value: card.currencyCode },
          { kind: "select", name: "roleCode", label: t("crew.fields.role"), options: roleOptions },
          { kind: "select", name: "worker", label: t("crew.rates.classification"), options: classes.map((c) => ({ value: c.code, label: c.label })) },
          { kind: "select", name: "payBasis", label: t("crew.rates.payBasis"), help: t("crew.rates.pairHelp"), options: canon.payBases.map((b) => ({ value: `${b.payBasis}|${b.classification}`, label: t("crew.rates.pairOption", { value: b.payBasis, classification: className(b.classification) }) })) },
          { kind: "select", name: "arrangement", label: t("crew.rates.arrangement"), options: canon.arrangements.map((a) => ({ value: `${a.arrangement}|${a.classification}`, label: t("crew.rates.pairOption", { value: a.arrangement, classification: className(a.classification) }) })) },
          { kind: "select", name: "overtimeRuleId", label: t("crew.rates.overtime"), options: canon.overtimeRules.map((r) => ({ value: r.id, label: `${r.id} · ${r.name}` })) },
          { kind: "select", name: "canonRateCardId", label: t("crew.rates.canonCard"), options: [{ value: "", label: t("crew.rates.notAdopted") }, ...canon.canonRateCards.filter((c) => c.currencyCode === card.currencyCode).map((c) => ({ value: c.id, label: `${c.id} · ${roleName(c.roleCode)}` }))] },
          { kind: "money", name: "rate", label: t("crew.rates.rateIn", { currency: card.currencyCode }), help: t("crew.rates.rateHelp") },
        ]}
      />
    );
  } else if (editLine && canWrite && card && !editLine.masked) {
    drawer = (
      <DrawerForm
        title={t("crew.rates.editRate")}
        submitLabel={t("crew.common.save")}
        action={updateRateLineAction}
        openKeys={["editLine"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "id", value: editLine.id },
          { kind: "hidden", name: "currencyCode", value: card.currencyCode },
          { kind: "select", name: "overtimeRuleId", label: t("crew.rates.overtime"), value: editLine.overtimeRuleId, options: canon.overtimeRules.map((r) => ({ value: r.id, label: `${r.id} · ${r.name}` })) },
          { kind: "money", name: "rate", label: t("crew.rates.rateIn", { currency: card.currencyCode }), value: fromMinor(editLine.rateMinor, exponent), help: t("crew.rates.rateHelp") },
        ]}
      />
    );
  } else if (search["payRate"] === "1" && canPay) {
    drawer = (
      <DrawerForm
        title={t("crew.rates.recordTitle")}
        submitLabel={t("crew.rates.record")}
        action={recordPayRateAction}
        openKeys={["payRate"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "select", name: "membershipId", label: t("crew.fields.person"), options: members.map((m) => ({ value: m.membershipId, label: m.name ?? t("crew.common.unnamed") })) },
          { kind: "select", name: "roleCode", label: t("crew.fields.role"), options: roleOptions },
          { kind: "text", name: "currencyCode", label: t("crew.rates.currency"), value: card?.currencyCode ?? "USD", required: true },
          { kind: "money", name: "rate", label: t("crew.rates.hourly"), required: true },
          { kind: "date", name: "effectiveFrom", label: t("crew.rates.effectiveFrom"), value: today, required: true },
        ]}
      />
    );
  }

  const cardList = (
    <nav aria-label={t("crew.rates.cards")} className="flex flex-wrap gap-8">
      {cards.map((c) => {
        const phase = rateCardPhase(c, today);
        const current = c.id === card?.id;
        return (
          <Link
            key={c.id}
            href={withParams(base, search, { card: c.id, peek: null }) as Route}
            aria-current={current ? "page" : undefined}
            className={current ? "flex flex-col gap-2 rounded-card border border-accent px-12 py-8" : "flex flex-col gap-2 rounded-card border border-border-subtle px-12 py-8 hover:bg-bg-hover"}
          >
            <span className="text-text-13 font-medium">{c.name}</span>
            <span className="text-text-12 text-text-secondary">
              {t("crew.rates.cardMeta", { currency: c.currencyCode, count: c.lineCount, phase: t(`crew.states.rateCard.${phase}`) })}
            </span>
          </Link>
        );
      })}
    </nav>
  );

  const lineRows = lines.map((l) => ({
    id: l.id,
    role: roleName(l.roleCode),
    classification: className(l.workerClassification),
    basis: l.payBasis,
    arrangement: l.arrangement,
    overtime: `${l.overtimeRuleId} · ${ruleName(l.overtimeRuleId)}`,
    rate: l.rateMinor === null ? null : l.rateMinor / 10 ** exponent,
  }));
  const linesBody =
    !card ? null : lines.length === 0 ? (
      <EmptyStateLink
        icon="Table2"
        sentence={canWrite ? t("crew.rates.noLinesWriter") : t("crew.rates.noLinesReader")}
        actionLabel={canWrite ? t("crew.rates.addLine") : t("crew.rates.viewCanon")}
        href={canWrite ? withParams(base, search, { addLine: "1", ...keep }) : `/${crew.slug}/canon/roles`}
      />
    ) : view === "spreadsheet" && !masked ? (
      <RateGrid
        label={t("crew.rates.gridLabel", { card: card.name })}
        org={crew.slug}
        currency={card.currencyCode}
        editable={canWrite}
        action={saveRatesAction}
        columns={[
          { key: "role", label: t("crew.fields.role"), type: "text", width: 280 },
          { key: "classification", label: t("crew.rates.classification"), type: "text" },
          { key: "basis", label: t("crew.rates.payBasis"), type: "text" },
          { key: "arrangement", label: t("crew.rates.arrangement"), type: "text" },
          { key: "overtime", label: t("crew.rates.overtime"), type: "text" },
          { key: "rate", label: t("crew.rates.rate"), type: "money", total: false },
        ]}
        rows={lineRows}
      />
    ) : (
      <PeekTable
        caption={t("crew.rates.gridLabel", { card: card.name })}
        columns={[
          { key: "role", label: t("crew.fields.role"), wrap: true },
          { key: "classification", label: t("crew.rates.classification") },
          { key: "basis", label: t("crew.rates.payBasis") },
          { key: "arrangement", label: t("crew.rates.arrangement") },
          { key: "overtime", label: t("crew.rates.overtime") },
          { key: "rate", label: t("crew.rates.rate") },
        ]}
        rows={lines.map((l) => ({ ...lineRows.find((r) => r.id === l.id), id: l.id, rate: money(format, t, l.rateMinor, card.currencyCode, l.masked, exponent) }))}
      />
    );

  const rateRow = (r: PayRate) => ({
    id: `rate:${r.id}`,
    person: r.member.name ?? t("crew.common.unnamed"),
    role: roleName(r.roleCode),
    from: format.dateTime(new Date(`${r.effectiveFrom}T12:00:00Z`), { timeZone: "UTC", dateStyle: "medium" }),
    rate: money(format, t, r.rateMinor, r.currencyCode, r.masked),
  });

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={cards.length}
      view={view}
      {...(canWrite ? { actions: <ButtonLink href={withParams(base, search, { create: "1" })} variant="primary" size="sm">{t("crew.rates.create")}</ButtonLink> } : {})}
      peek={
        <>
          {peek}
          {drawer}
        </>
      }
    >
      {cards.length === 0 ? (
        <EmptyStateLink
          icon="Table2"
          sentence={canWrite ? t("crew.rates.emptyWriter") : t("crew.rates.emptyReader")}
          actionLabel={canWrite ? t("crew.rates.create") : t("crew.rates.viewCanon")}
          href={canWrite ? withParams(base, search, { create: "1" }) : `/${crew.slug}/canon/roles`}
        />
      ) : (
        <div className="flex flex-col gap-16">
          {cardList}
          {card ? (
            <section aria-labelledby="rate-card-heading" className="flex flex-col gap-12">
              <div className="flex flex-wrap items-center justify-between gap-8">
                <div className="flex flex-wrap items-center gap-8">
                  <h2 id="rate-card-heading" className="m-0 text-heading-16 font-semibold">{card.name}</h2>
                  <StateChip state={stateIcon("rateCard", rateCardPhase(card, today))} label={t(`crew.states.rateCard.${rateCardPhase(card, today)}`)} />
                  <span className="text-text-12 text-text-secondary">
                    {card.effectiveTo
                      ? t("crew.common.range", { start: card.effectiveFrom, end: card.effectiveTo })
                      : t("crew.rates.fromOn", { date: card.effectiveFrom })}
                  </span>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap gap-8">
                    <ButtonLink href={withParams(base, search, { addLine: "1", ...keep })} size="sm">{t("crew.rates.addLine")}</ButtonLink>
                    <ButtonLink href={withParams(base, search, { edit: "1", ...keep })} size="sm">{t("crew.common.edit")}</ButtonLink>
                    <ConfirmButton label={t("crew.common.trash")} title={t("crew.rates.trashTitle")} description={t("crew.shifts.trashHelp")} defaultReason={t("crew.shifts.trashReason")} reason={false} action={trashRateCardAction} hidden={{ org: crew.slug, id: card.id }} variant="ghost" />
                  </div>
                ) : null}
              </div>
              {masked ? (
                <InlineAlert tone="info" title={t("crew.rates.maskedTitle")}>
                  {t("crew.rates.maskedBody")}
                </InlineAlert>
              ) : null}
              {linesBody}
            </section>
          ) : null}
        </div>
      )}
      <section aria-labelledby="pay-rate-heading" className="flex flex-col gap-12">
        <div className="flex flex-wrap items-center justify-between gap-8">
          <h2 id="pay-rate-heading" className="m-0 text-heading-16 font-semibold">{t("crew.rates.ledger")}</h2>
          {canPay ? (
            <ButtonLink href={withParams(base, search, { payRate: "1", ...keep })} size="sm">{t("crew.rates.record")}</ButtonLink>
          ) : null}
        </div>
        {rates.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{canPay ? t("crew.rates.noRatesWriter") : t("crew.rates.noRatesReader")}</p>
        ) : (
          <PeekTable
            caption={t("crew.rates.ledger")}
            columns={[
              { key: "person", label: t("crew.fields.person") },
              { key: "role", label: t("crew.fields.role"), wrap: true },
              { key: "from", label: t("crew.rates.effectiveFrom") },
              { key: "rate", label: t("crew.rates.hourly") },
            ]}
            rows={rates.map(rateRow)}
          />
        )}
      </section>
    </CrewFrame>
  );
}
