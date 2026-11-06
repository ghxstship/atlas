"use client";

import { currencyDigits } from "@xos/data/documents/format";
import type { AdvancePacket, TokenDocument, TokenQuote } from "@xos/data/gateway";
import { advanceSectionOpen } from "@xos/data/gateway-public";
import { Button, InlineAlert, Input, Textarea, buttonClass } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { enumLabelKey } from "@/lib/enum-key";
import {
  answerAdvanceTokenAction,
  openAdvanceAction,
  openDocumentAction,
  openQuoteAction,
  signDocumentTokenAction,
  type TokenOutcome,
} from "@/lib/actions/tokens";

type Translate = (key: string, values?: Record<string, string | number>) => string;

function useCopy(): Translate {
  return useTranslations("gateway.tokens") as unknown as Translate;
}

function Problem({ result }: { result: TokenOutcome<unknown> | null }) {
  const t = useCopy();
  const to = useTranslations("gateway.outcomes") as unknown as Translate;
  if (!result || result.ok) return null;
  return (
    <InlineAlert tone="danger">
      {result.refusal ? t(`refusals.${result.refusal}`) : to(result.outcome ?? "unexpected")}
    </InlineAlert>
  );
}

/** The access code step every token link starts with (Section 4.4.6). */
function AccessCode({
  label,
  onOpen,
  pending,
  result,
}: {
  label: string;
  onOpen: (code: string) => void;
  pending: boolean;
  result: TokenOutcome<unknown> | null;
}) {
  const t = useCopy();
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-12"
      aria-label={label}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onOpen(code);
      }}
    >
      <Problem result={result} />
      <Input
        id="access-code"
        name="accessCode"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        label={t("code")}
        help={t("codeHelp")}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          {t("open")}
        </Button>
      </div>
    </form>
  );
}

/** After a token flow: offer an account, which claims the submissions by verified email. */
function ClaimOffer({ title }: { title: string }) {
  const t = useCopy();
  return (
    <section
      aria-labelledby="claim-offer"
      className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16"
    >
      <h2 id="claim-offer" className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("claimBody")}</p>
      <div className="flex flex-wrap gap-8">
        <NextLink
          href={"/auth/sign-up?next=%2Fauth%2Fclaim" as Route}
          className={buttonClass("primary", "md")}
        >
          {t("claimCreate")}
        </NextLink>
        <NextLink
          href={"/auth/sign-in?next=%2Fauth%2Fclaim" as Route}
          className={buttonClass("secondary", "md")}
        >
          {t("claimSignIn")}
        </NextLink>
      </div>
    </section>
  );
}

function Header({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4">
      <span className="text-text-13 text-text-secondary">{eyebrow}</span>
      <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
      {children}
    </header>
  );
}

/** An advance form opened by link and access code (Section 4.4.6, journey 50). */
export function AdvanceTokenFlow({ token }: { token: string }) {
  const t = useCopy();
  const [pending, start] = useTransition();
  const [code, setCode] = useState("");
  const [opened, setOpened] = useState<TokenOutcome<AdvancePacket> | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, TokenOutcome<{ submittedAt: string }>>>({});
  if (!opened?.ok) {
    return (
      <div className="flex flex-col gap-16">
        <Header eyebrow={t("advance.eyebrow")} title={t("advance.title")} />
        <AccessCode
          label={t("advance.title")}
          pending={pending}
          result={opened}
          onOpen={(c) =>
            start(async () => {
              setCode(c);
              setOpened(await openAdvanceAction({ token, accessCode: c }));
            })
          }
        />
      </div>
    );
  }
  const packet = opened.data;
  // A section takes an answer while it has none or its latest answer was returned (migration 2604).
  const remaining = packet.sections.filter((s) => advanceSectionOpen(s) && !sent[s.id]?.ok).length;
  return (
    <div className="flex flex-col gap-16">
      <Header eyebrow={packet.orgName} title={packet.title}>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("advance.remaining", { n: remaining })}
        </p>
      </Header>
      <ol className="m-0 flex list-none flex-col gap-16 p-0">
        {packet.sections.map((s) => {
          const result = sent[s.id];
          const answered = !advanceSectionOpen(s) || result?.ok;
          return (
            <li
              key={s.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16"
            >
              <h2 className="m-0 text-heading-16 font-semibold">
                {t("advance.section", { n: s.position, title: s.title })}
              </h2>
              {s.prompt ? <p className="m-0 text-text-13 text-text-secondary">{s.prompt}</p> : null}
              {s.answer ? (
                <p className="m-0 whitespace-pre-line rounded-control bg-bg-surface p-8 text-text-13">
                  {s.answer}
                </p>
              ) : null}
              {s.reviewOutcome === "Returned" && !result?.ok ? (
                <InlineAlert tone="warning">
                  {t("advance.returned", { reason: s.returnReason ?? "" })}
                </InlineAlert>
              ) : null}
              {result?.ok ? <InlineAlert tone="success">{t("advance.sent")}</InlineAlert> : null}
              <Problem result={result ?? null} />
              {!answered ? (
                <form
                  className="flex flex-col gap-8"
                  onSubmit={(event) => {
                    event.preventDefault();
                    start(async () => {
                      const next = await answerAdvanceTokenAction({
                        token,
                        accessCode: code,
                        sectionId: s.id,
                        body: answers[s.id] ?? "",
                      });
                      setSent((prev) => ({ ...prev, [s.id]: next }));
                    });
                  }}
                >
                  <Textarea
                    id={`answer-${s.id}`}
                    label={t("advance.answer")}
                    rows={3}
                    width="100%"
                    required
                    value={answers[s.id] ?? ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  />
                  <div>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={pending}
                      aria-busy={pending}
                    >
                      {t("advance.submit")}
                    </Button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ol>
      {remaining === 0 ? <ClaimOffer title={t("advance.done")} /> : null}
    </div>
  );
}

/** A signing link opened by access code (Section 4.4.6, journey 9): read, type a name, sign. */
export function SignTokenFlow({ token }: { token: string }) {
  const t = useCopy();
  const tRoot = useTranslations() as unknown as Translate;
  const [pending, start] = useTransition();
  const [code, setCode] = useState("");
  const [opened, setOpened] = useState<TokenOutcome<TokenDocument> | null>(null);
  const [quote, setQuote] = useState<TokenQuote["quote"] | null>(null);
  const [name, setName] = useState("");
  const [signed, setSigned] = useState<TokenOutcome<{ signedAt: string }> | null>(null);
  if (!opened?.ok) {
    return (
      <div className="flex flex-col gap-16">
        <Header eyebrow={t("sign.eyebrow")} title={t("sign.title")} />
        <AccessCode
          label={t("sign.title")}
          pending={pending}
          result={opened}
          onOpen={(c) =>
            start(async () => {
              setCode(c);
              const doc = await openDocumentAction({ token, accessCode: c });
              // A quote shows its lines, total and terms before anyone can accept it.
              if (doc.ok && doc.data.kind === "Quote") {
                const q = await openQuoteAction({ token, accessCode: c });
                if (!q.ok) {
                  setOpened(q);
                  return;
                }
                setQuote(q.data.quote);
              }
              setOpened(doc);
            })
          }
        />
      </div>
    );
  }
  const doc = opened.data;
  const alreadySigned = Boolean(doc.signedAt) || signed?.ok;
  return (
    <div className="flex flex-col gap-16">
      <Header
        eyebrow={[doc.orgName, doc.projectName].filter(Boolean).join(" · ")}
        title={doc.title}
      >
        <p className="m-0 text-text-13 text-text-secondary">
          {t("sign.state", { state: tRoot(enumLabelKey("engagementDocumentState", doc.state)) })}
        </p>
      </Header>
      {quote ? (
        <QuoteSummary quote={quote} token={token} code={code} />
      ) : doc.storageUri ? (
        <p className="m-0 text-text-13">{t("sign.read")}</p>
      ) : null}
      {alreadySigned ? (
        <>
          <InlineAlert tone="success">
            {t("sign.signed", { name: doc.signerName ?? name })}
          </InlineAlert>
          <ClaimOffer title={t("sign.done")} />
        </>
      ) : (
        <form
          className="flex flex-col gap-12"
          aria-label={t("sign.title")}
          onSubmit={(event) => {
            event.preventDefault();
            start(async () =>
              setSigned(
                await signDocumentTokenAction({ token, accessCode: code, signerName: name }),
              ),
            );
          }}
        >
          <Problem result={signed} />
          {quote ? <p className="m-0 text-text-13">{t("sign.quote.consent")}</p> : null}
          <Input
            id="signer-name"
            autoComplete="name"
            required
            label={t("sign.name")}
            help={t("sign.nameHelp")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div>
            <Button
              type="submit"
              variant="primary"
              icon="FileSignature"
              disabled={pending}
              aria-busy={pending}
            >
              {quote ? t("sign.quote.submit") : t("sign.submit")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** A quote's client-facing content on its signing link: lines, total, valid until, terms and fingerprint. */
function QuoteSummary({
  quote,
  token,
  code,
}: {
  quote: TokenQuote["quote"];
  token: string;
  code: string;
}) {
  const t = useCopy();
  const money = (minor: number | null) =>
    minor === null
      ? t("sign.quote.unpriced")
      : new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: quote.currency_code,
        }).format(minor / 10 ** currencyDigits(quote.currency_code));
  return (
    <section aria-label={t("sign.quote.lines")} className="flex flex-col gap-12">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-text-13">
          <caption className="sr-only">{t("sign.quote.lines")}</caption>
          <thead>
            <tr className="text-text-secondary">
              <th scope="col" className="py-4 text-start font-medium">
                {t("sign.quote.description")}
              </th>
              <th scope="col" className="py-4 text-end font-medium">
                {t("sign.quote.quantity")}
              </th>
              <th scope="col" className="py-4 text-end font-medium">
                {t("sign.quote.unitPrice")}
              </th>
              <th scope="col" className="py-4 text-end font-medium">
                {t("sign.quote.amount")}
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l) => (
              <tr key={l.id} className="border-t border-border-subtle">
                <td className="py-6">{l.description}</td>
                <td className="py-6 text-end tabular-nums">{l.quantity}</td>
                <td className="py-6 text-end tabular-nums">{money(l.unit_price_minor)}</td>
                <td className="py-6 text-end tabular-nums">{money(l.amount_minor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-subtle font-medium">
              <th scope="row" colSpan={3} className="py-6 text-start">
                {t("sign.quote.total")}
              </th>
              <td className="py-6 text-end tabular-nums">{money(quote.total_minor)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="m-0 text-text-13">
        {t("sign.quote.validUntil", { date: quote.valid_until })}
      </p>
      {quote.terms ? <p className="m-0 text-text-13 whitespace-pre-wrap">{quote.terms}</p> : null}
      <p className="m-0 text-text-12 text-text-secondary">{t("sign.quote.tax")}</p>
      {quote.content_sha256 ? (
        <p className="m-0 break-all text-text-12 text-text-secondary">
          {t("sign.quote.fingerprint")}: <span className="font-mono">{quote.content_sha256}</span>
        </p>
      ) : null}
      {/* Posted, so the access code travels in the form body and never in a URL. */}
      <form method="post" action={`/sign/${token}/quote`} className="flex flex-wrap gap-8">
        <input type="hidden" name="accessCode" value={code} />
        <Button type="submit" size="sm" name="paper" value="letter">
          {t("sign.quote.downloadPdf")}
        </Button>
        <Button type="submit" size="sm" name="paper" value="a4">
          {t("sign.quote.downloadPdfA4")}
        </Button>
      </form>
    </section>
  );
}
