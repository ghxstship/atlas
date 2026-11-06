import { listBudgets } from "@xos/data/finance";
import { getQuote, listQuotes, QUOTE_DISPLAY_STATES, quoteAcceptanceEmail } from "@xos/data/quotes";
import { listEngagementOptions } from "@xos/data/project-people";
import { getNode } from "@xos/ia";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DocumentActions } from "@/components/documents/document-actions";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { declineQuoteAction, withdrawQuoteAction } from "@/app/[org]/finance/quote-actions";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Figures, Section, SimpleTable } from "./figures";
import { QuoteForm } from "./forms-quote-form";
import { InlineActionButton } from "./kit-inline-action-button";
import { FormSheet } from "./kit-form-sheet";
import { type Row } from "./kit.types";
import {
  DeleteDraftButton,
  NewVersionButton,
  QuoteDialogHost,
  QuoteDraftForm,
  SendQuoteButton,
  SigningLinkButton,
} from "./quote-client";
import { CLIENT_QUOTE_STATE } from "./quote-states";

/**
 * Finance > Quotes (G-188 phase 1, ADR 0152): a quote prices from a budget and goes to a Client
 * engagement. A Draft reads live prices, with cost and margin under "Internal: never on the quote";
 * sending freezes it; the client's signature accepts it and locks it, and later changes go through
 * change orders. XOS never holds funds, so a quote has no Paid state.
 */
export async function QuotesView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.quotes").node.label);
  const empty = {
    icon: "FileSignature",
    sentence: page.project
      ? t("finance.quotes.emptyProject", { project: page.project.key })
      : t("finance.quotes.empty"),
    actionLabel: t("finance.quotes.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.quotes.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.budget.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.budget.read" />;
  }
  const db = ctx.viewer.db;
  // A document's QR code opens a version id in the peek; the quote's peek shows every version.
  if (query.peek) {
    const { data } = await db
      .from("quote_versions")
      .select("quote_id")
      .eq("id", query.peek)
      .maybeSingle();
    if (data) redirect(withQuery(page, { peek: data.quote_id }) as Route);
  }
  // An engagement's Quote document links to its quote.
  const documentLink = query.extra["document"];
  if (documentLink) {
    const { data } = await db
      .from("quote_versions")
      .select("quote_id")
      .eq("engagement_document_id", documentLink)
      .maybeSingle();
    if (data) redirect(withQuery(page, { document: null, peek: data.quote_id }) as Route);
  }
  const scope = { orgId: ctx.org.id, projectId: page.project?.id ?? null };
  const [quotes, budgets] = await Promise.all([listQuotes(db, scope), listBudgets(db, scope)]);
  if (!quotes.ok || !budgets.ok) {
    return <FinanceCollection {...base} canCreate={false} error={t("finance.quotes.loadError")} />;
  }
  const canWrite = access.can("finance.budget.write");
  const canApprove = access.can("finance.budget.approve");
  const canIssueLink = access.can("opportunities.engagement.write");
  const projectOf = new Map(page.projects.map((p) => [p.id, p]));
  const term = query.q?.toLowerCase() ?? null;
  const shown = quotes.data.filter(
    (q) =>
      (!query.state || q.displayState === query.state) &&
      (term === null ||
        q.title.toLowerCase().includes(term) ||
        q.key.toLowerCase().includes(term) ||
        (q.clientName ?? "").toLowerCase().includes(term)),
  );
  const stateLabel = (s: string) => t(`finance.quotes.states.${s}`);
  const rows: Row[] = shown.map((q) => ({
    id: q.id,
    key: q.key,
    title: q.title,
    project: projectOf.get(q.projectId)?.key ?? "",
    client: q.clientName ?? "",
    version: q.currentVersionNumber,
    state: { state: CLIENT_QUOTE_STATE[q.displayState], label: stateLabel(q.displayState) },
    total: c.money(q.clientTotalMinor, q.currency),
    margin: c.money(q.marginMinor, q.currency),
    validUntil: c.date(q.validUntil),
    sent: q.sentAt ? c.dateTime(q.sentAt) : "",
    accepted: q.acceptedAt ? c.dateTime(q.acceptedAt) : "",
  }));

  const peek = query.peek ? quotes.data.find((q) => q.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const loaded = await getQuote(db, peek.id);
    if (loaded.ok) {
      const q = loaded.data.status;
      const versions = loaded.data.versions;
      const current = versions.find((v) => v.id === q.currentVersionId);
      const draft = versions.find((v) => v.state === "Draft");
      const accepted = versions.find((v) => v.state === "Accepted");
      const email = accepted ? await quoteAcceptanceEmail(db, accepted.id) : null;
      const project = projectOf.get(q.projectId);
      const zone = await db.from("projects").select("time_zone").eq("id", q.projectId).maybeSingle();
      const timeZone = zone.data?.time_zone ?? "UTC";
      const money = (minor: number | null) => c.money(minor, q.currency);
      const marginPercent =
        q.marginMinor !== null && q.clientTotalMinor ? (q.marginMinor / q.clientTotalMinor) * 100 : null;
      detail = {
        kindLabel: t("finance.quotes.kind"),
        recordKey: q.key,
        title: q.title,
        state: CLIENT_QUOTE_STATE[q.displayState],
        stateLabel: stateLabel(q.displayState),
        propertiesLabel: t("finance.common.properties"),
        properties: [
          { label: t("finance.quotes.fields.client"), value: q.clientName ?? t("finance.common.none") },
          { label: t("finance.common.project"), value: project?.key ?? "" },
          { label: t("finance.quotes.fields.validUntil"), value: c.date(q.validUntil) },
          { label: t("finance.common.currency"), value: q.currency },
        ],
        content: (
          <>
            {accepted ? (
              <p role="status" className="m-0 text-text-13">
                {t("finance.quotes.lockedSentence")}{" "}
                <Link
                  className="text-accent-text underline"
                  href={`/${ctx.org.slug}/finance/change-orders` as Route}
                >
                  {t("finance.quotes.changeOrders")}
                </Link>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-8">
              {draft && canApprove ? (
                <SendQuoteButton
                  versionId={draft.id}
                  validUntil={draft.validUntil}
                  timeZone={timeZone}
                  canIssueLink={canIssueLink}
                />
              ) : null}
              {!accepted && !draft && canWrite ? (
                <NewVersionButton org={ctx.org.slug} quoteId={q.id} />
              ) : null}
              {current?.state === "Sent" && canIssueLink && current.engagementDocumentId ? (
                <SigningLinkButton
                  documentId={current.engagementDocumentId}
                  validUntil={current.validUntil}
                  timeZone={timeZone}
                />
              ) : null}
              {current?.state === "Sent" && canApprove ? (
                <>
                  <InlineActionButton
                    action={withdrawQuoteAction}
                    fields={{ org: ctx.org.slug, versionId: current.id }}
                    label={t("finance.quotes.actions.withdraw")}
                  />
                  <InlineActionButton
                    action={declineQuoteAction}
                    fields={{ org: ctx.org.slug, versionId: current.id }}
                    label={t("finance.quotes.actions.decline")}
                  />
                </>
              ) : null}
              {draft && canWrite ? (
                <DeleteDraftButton org={ctx.org.slug} quoteId={q.id} versionId={draft.id} />
              ) : null}
              {current ? <DocumentActions org={ctx.org.slug} kind="quote" id={current.id} /> : null}
            </div>
            <Figures
              label={t("finance.quotes.figures.label")}
              items={[
                { label: t("finance.quotes.figures.clientTotal"), value: money(q.clientTotalMinor) },
                { label: t("finance.quotes.figures.cost"), value: money(loaded.data.costTotalMinor) },
                { label: t("finance.quotes.figures.margin"), value: money(q.marginMinor) },
                {
                  label: t("finance.quotes.figures.marginPercent"),
                  value: marginPercent === null ? t("finance.common.none") : `${c.number(Math.round(marginPercent * 10) / 10)}%`,
                },
              ]}
            />
            {draft && canWrite ? (
              <Section id="quote-draft" title={t("finance.quotes.draftSection")}>
                <QuoteDraftForm
                  org={ctx.org.slug}
                  versionId={draft.id}
                  validUntil={draft.validUntil}
                  terms={draft.terms}
                />
              </Section>
            ) : null}
            <Section id="quote-lines" title={t("finance.quotes.lines")}>
              <SimpleTable
                caption={t("finance.quotes.lines")}
                head={[
                  t("finance.common.description"),
                  t("finance.budgets.columns.quantity"),
                  t("finance.budgets.columns.unit"),
                  t("finance.budgets.columns.clientUnitPrice"),
                  t("finance.budgets.columns.clientAmount"),
                  t("finance.quotes.internalCost"),
                  t("finance.quotes.internalMargin"),
                ]}
                numeric={[1, 3, 4, 5, 6]}
                rows={loaded.data.lines.map((l) => [
                  l.description,
                  c.number(l.quantity),
                  l.unitBasis ?? "",
                  money(l.clientUnitPriceMinor),
                  money(l.clientAmountMinor),
                  money(l.costAmountMinor),
                  money(l.marginMinor),
                ])}
                foot={[
                  t("finance.common.total"),
                  "",
                  "",
                  "",
                  money(q.clientTotalMinor),
                  money(loaded.data.costTotalMinor),
                  money(q.marginMinor),
                ]}
              />
              <p className="m-0 text-text-12 text-text-secondary">{t("finance.quotes.internalNote")}</p>
            </Section>
            {accepted ? (
              <Section id="quote-signature" title={t("finance.quotes.signature")}>
                <dl className="m-0 grid grid-cols-2 gap-8 text-text-13 max-sm:grid-cols-1">
                  <div>
                    <dt className="text-text-secondary">{t("finance.quotes.nameAsSigned")}</dt>
                    <dd className="m-0">{accepted.acceptedName ?? t("finance.common.none")}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t("finance.quotes.signedAt")}</dt>
                    <dd className="m-0">{accepted.acceptedAt ? c.dateTime(accepted.acceptedAt) : ""}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t("finance.quotes.howSigned")}</dt>
                    <dd className="m-0">
                      {email?.ok && email.data
                        ? t("finance.quotes.signedByLink", { email: email.data })
                        : t("finance.quotes.signedIn")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t("finance.quotes.fingerprint")}</dt>
                    <dd className="m-0 break-all font-mono text-text-12">{accepted.contentSha256}</dd>
                  </div>
                </dl>
              </Section>
            ) : null}
            <Section id="quote-versions" title={t("finance.quotes.versions")}>
              <SimpleTable
                caption={t("finance.quotes.versions")}
                head={[
                  t("finance.quotes.fields.version"),
                  t("finance.common.state"),
                  t("finance.quotes.fields.validUntil"),
                  t("finance.quotes.fields.sent"),
                ]}
                numeric={[0]}
                rows={versions.map((v) => [
                  String(v.versionNumber),
                  stateLabel(v.state),
                  c.date(v.validUntil),
                  v.sentAt ? c.dateTime(v.sentAt) : "",
                ])}
              />
            </Section>
          </>
        ),
      };
    }
  }

  const engagementOptions = canWrite ? await listEngagementOptions(db, scope) : null;
  const sheet =
    query.create && canWrite ? (
      <FormSheet title={t("finance.quotes.create")} flag="create">
        <QuoteForm
          org={ctx.org.slug}
          budgets={budgets.data.map((b) => ({
            value: b.id,
            label: `${b.projectKey ?? ""} · ${b.name}`,
            projectId: b.projectId,
            hasDefaultMarkup: b.defaultMarkupBp !== null,
          }))}
          engagements={
            engagementOptions?.ok
              ? engagementOptions.data
                  .filter((e) => e.roleType === "Client")
                  .map((e) => ({
                    value: e.engagementId,
                    label: e.personName ?? e.accountName ?? e.projectKey,
                    projectId: e.projectId,
                  }))
              : []
          }
        />
      </FormSheet>
    ) : null;

  return (
    <QuoteDialogHost org={ctx.org.slug}>
      <FinanceCollection
        {...base}
        canCreate={canWrite}
        count={shown.length}
        states={QUOTE_DISPLAY_STATES.map((s) => ({ value: s, label: stateLabel(s) }))}
        columns={[
          { key: "key", label: t("finance.common.key"), type: "code" },
          { key: "title", label: t("finance.quotes.fields.title"), wrap: true },
          { key: "project", label: t("finance.common.project"), type: "code" },
          { key: "client", label: t("finance.quotes.fields.client") },
          { key: "version", label: t("finance.quotes.fields.version"), type: "number" },
          { key: "state", label: t("finance.common.state"), type: "state" },
          { key: "total", label: t("finance.quotes.figures.clientTotal"), type: "number" },
          { key: "margin", label: t("finance.quotes.figures.margin"), type: "number" },
          { key: "validUntil", label: t("finance.quotes.fields.validUntil") },
          { key: "sent", label: t("finance.quotes.fields.sent") },
          { key: "accepted", label: t("finance.quotes.fields.accepted") },
        ]}
        rows={rows}
        listItems={shown.map((q) => ({
          id: q.id,
          recordKey: q.key,
          title: q.title,
          state: CLIENT_QUOTE_STATE[q.displayState],
          stateLabel: stateLabel(q.displayState),
          next: c.money(q.clientTotalMinor, q.currency),
        }))}
        board={QUOTE_DISPLAY_STATES.map((s) => ({
          state: CLIENT_QUOTE_STATE[s],
          label: stateLabel(s),
          cards: shown
            .filter((q) => q.displayState === s)
            .map((q) => ({
              key: q.id,
              title: `${q.key} ${q.title}`,
              meta: c.money(q.clientTotalMinor, q.currency),
            })),
        }))}
        detail={detail}
        sheet={sheet}
      />
    </QuoteDialogHost>
  );
}
