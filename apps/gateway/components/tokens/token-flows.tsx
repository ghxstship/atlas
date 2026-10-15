"use client";

import type { AdvancePacket, TokenDocument } from "@xos/data/gateway";
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
    <section aria-labelledby="claim-offer" className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16">
      <h2 id="claim-offer" className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("claimBody")}</p>
      <div className="flex flex-wrap gap-8">
        <NextLink href={"/auth/sign-up?next=%2Fauth%2Fclaim" as Route} className={buttonClass("primary", "md")}>
          {t("claimCreate")}
        </NextLink>
        <NextLink href={"/auth/sign-in?next=%2Fauth%2Fclaim" as Route} className={buttonClass("secondary", "md")}>
          {t("claimSignIn")}
        </NextLink>
      </div>
    </section>
  );
}

function Header({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
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
  const remaining = packet.sections.filter((s) => !s.answer && !sent[s.id]?.ok).length;
  return (
    <div className="flex flex-col gap-16">
      <Header eyebrow={packet.orgName} title={packet.title}>
        <p className="m-0 text-text-13 text-text-secondary">{t("advance.remaining", { n: remaining })}</p>
      </Header>
      <ol className="m-0 flex list-none flex-col gap-16 p-0">
        {packet.sections.map((s) => {
          const result = sent[s.id];
          const answered = Boolean(s.answer) || result?.ok;
          return (
            <li key={s.id} className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16">
              <h2 className="m-0 text-heading-16 font-semibold">
                {`${s.position}. ${s.title}`}
              </h2>
              {s.prompt ? <p className="m-0 text-text-13 text-text-secondary">{s.prompt}</p> : null}
              {s.answer ? <p className="m-0 whitespace-pre-line rounded-control bg-bg-surface p-8 text-text-13">{s.answer}</p> : null}
              {result?.ok ? <InlineAlert tone="success">{t("advance.sent")}</InlineAlert> : null}
              <Problem result={result ?? null} />
              {!answered ? (
                <form
                  className="flex flex-col gap-8"
                  onSubmit={(event) => {
                    event.preventDefault();
                    start(async () => {
                      const next = await answerAdvanceTokenAction({ token, accessCode: code, sectionId: s.id, body: answers[s.id] ?? "" });
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
                    <Button type="submit" variant="primary" size="sm" disabled={pending} aria-busy={pending}>
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
              setOpened(await openDocumentAction({ token, accessCode: c }));
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
      <Header eyebrow={[doc.orgName, doc.projectName].filter(Boolean).join(" · ")} title={doc.title}>
        <p className="m-0 text-text-13 text-text-secondary">{t("sign.state", { state: tRoot(enumLabelKey("engagementDocumentState", doc.state)) })}</p>
      </Header>
      {doc.storageUri ? <p className="m-0 text-text-13">{t("sign.read")}</p> : null}
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
            start(async () => setSigned(await signDocumentTokenAction({ token, accessCode: code, signerName: name })));
          }}
        >
          <Problem result={signed} />
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
            <Button type="submit" variant="primary" icon="FileSignature" disabled={pending} aria-busy={pending}>
              {t("sign.submit")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
