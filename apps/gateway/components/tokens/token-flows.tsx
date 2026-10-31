"use client";

import type { AdvancePacket, TokenDocument } from "@xos/data/gateway";
import {
  advanceSectionOpen,
  type AdvanceRosterEntry,
  type AdvanceSection,
} from "@xos/data/gateway-public";
import { Button, InlineAlert, Input, MoreFields, Textarea, buttonClass } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  useActionState,
  useEffect,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AdvanceFileForm,
  AdvanceLinesForm,
  GuestListConfirmForm,
} from "@/components/engagement/advance-forms";
import { FormShell, useCopy as useFormCopy } from "@/components/engagement/forms";
import type { FormResult } from "@/lib/actions/operations";
import { enumKey, enumLabelKey } from "@/lib/enum-key";
import {
  answerAdvanceTokenAction,
  answerAdvanceTypedTokenAction,
  inviteTokenRosterAction,
  listTokenRosterAction,
  openAdvanceAction,
  openDocumentAction,
  requestTokenGuestAction,
  signDocumentTokenAction,
  submitTokenRosterAction,
  uploadAdvanceTokenFileAction,
  type TokenOutcome,
} from "@/lib/actions/tokens";
import { withAdvanceLink, type AdvanceLink } from "@/lib/token-form";

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
  // R10: a typed answer went in through the token adapter; the packet is read again after it.
  const [typedSent, setTypedSent] = useState<Record<string, true>>({});
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
  const link = { token, accessCode: code };
  const answered = (sectionId: string) => {
    setTypedSent((prev) => ({ ...prev, [sectionId]: true }));
    start(async () => {
      const next = await openAdvanceAction(link);
      if (next.ok) setOpened(next);
    });
  };
  // A section takes an answer while it has none or its latest answer was returned (migration 2604),
  // and never a Crew Roster section, which the recipient builds instead (R10).
  const remaining = packet.sections.filter(
    (s) => advanceSectionOpen(s) && !sent[s.id]?.ok && !typedSent[s.id],
  ).length;
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
          const open = advanceSectionOpen(s) && !result?.ok && !typedSent[s.id];
          return (
            <li
              key={s.id}
              className="flex min-w-0 flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16"
            >
              <h2 className="m-0 text-heading-16 font-semibold">
                {t("advance.section", { n: s.position, title: s.title })}
              </h2>
              {s.prompt ? <p className="m-0 text-text-13 text-text-secondary">{s.prompt}</p> : null}
              {s.kind === "Text" && s.answer ? (
                <p className="m-0 whitespace-pre-line rounded-control bg-bg-surface p-8 text-text-13">
                  {s.answer}
                </p>
              ) : null}
              {s.kind !== "Text" && s.answerId ? <TokenAnswer section={s} packet={packet} /> : null}
              {s.reviewOutcome === "Returned" && open ? (
                <InlineAlert tone="warning">
                  {t("advance.returned", { reason: s.returnReason ?? "" })}
                </InlineAlert>
              ) : null}
              {s.reviewOutcome === "Accepted" ? (
                <p className="m-0 text-text-13 text-success-text">{t("advance.accepted")}</p>
              ) : null}
              {s.answer &&
              !s.reviewOutcome &&
              s.kind !== "Crew Roster" &&
              !typedSent[s.id] &&
              !result?.ok ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("advance.waiting")}</p>
              ) : null}
              {result?.ok || typedSent[s.id] ? (
                <InlineAlert tone="success">{t("advance.sent")}</InlineAlert>
              ) : null}
              <Problem result={result ?? null} />
              {s.kind === "Text" && open ? (
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
              {s.kind !== "Text" ? (
                <TokenTypedSection
                  section={s}
                  packet={packet}
                  link={link}
                  open={open}
                  onAnswered={() => answered(s.id)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {remaining === 0 ? <ClaimOffer title={t("advance.done")} /> : null}
    </div>
  );
}

/** What a typed answer holds, as the link shows it back: its note, lines and files. */
function TokenAnswer({ section, packet }: { section: AdvanceSection; packet: AdvancePacket }) {
  const tr = useTranslations() as unknown as Translate;
  const locale = useLocale();
  const names = new Map<string, string>();
  for (const c of section.choices) {
    if (c.assetClassId) names.set(c.assetClassId, c.className ?? "");
    if (c.credentialCategoryId) names.set(c.credentialCategoryId, c.categoryName ?? "");
  }
  const people = new Map(section.rosterPeople.map((p) => [p.rosterEntryId, p.displayName ?? ""]));
  const when = (iso: string, zone: string | null) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone ?? packet.timeZone,
      timeZoneName: "short",
    }).format(new Date(iso));
  if (section.kind === "Guest List") {
    return (
      <p className="m-0 text-text-13 text-text-secondary">
        {tr("gateway.engagement.advance.guestsConfirmed")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-8 rounded-control bg-bg-surface p-8 text-text-13">
      {section.answerNote ? <p className="m-0">{section.answerNote}</p> : null}
      {section.answerFiles.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-4 p-0"
          aria-label={tr("gateway.engagement.advance.filesLabel")}
        >
          {section.answerFiles.map((f) => (
            <li key={f.fileId} className="break-words">
              {f.title} · {tr(`gateway.engagement.advance.scan.${enumKey(f.scanStatus)}`)}
            </li>
          ))}
        </ul>
      ) : null}
      {section.answerLines.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-4 p-0"
          aria-label={tr("gateway.engagement.advance.linesLabel")}
        >
          {section.answerLines.map((l) => {
            const window =
              l.neededFrom && l.neededTo
                ? tr("gateway.engagement.advance.window", {
                    from: when(l.neededFrom, l.windowZone),
                    to: when(l.neededTo, l.windowZone),
                  })
                : null;
            const item = names.get(l.assetClassId ?? l.credentialCategoryId ?? "") ?? "";
            const parts =
              section.kind === "Schedule Window"
                ? [window]
                : [
                    tr("gateway.engagement.advance.lineTitle", { n: l.quantity ?? 0, item }),
                    l.rosterEntryId ? people.get(l.rosterEntryId) : null,
                    window,
                    l.note,
                  ];
            return (
              <li key={l.lineNumber} className="break-words">
                {parts.filter(Boolean).join(" · ")}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A typed section through the link (R10): R9's forms from the Advance tab with the token adapter,
 * plus the guest requests of a Guest List and the crew roster of a Crew Roster section.
 */
function TokenTypedSection({
  section,
  packet,
  link,
  open,
  onAnswered,
}: {
  section: AdvanceSection;
  packet: AdvancePacket;
  link: AdvanceLink;
  open: boolean;
  onAnswered: () => void;
}) {
  const t = useCopy();
  const tr = useTranslations() as unknown as Translate;
  const submit = withAdvanceLink(link, answerAdvanceTypedTokenAction, onAnswered);
  switch (section.kind) {
    case "File":
      return open ? (
        <>
          <p className="m-0 text-text-13 text-text-secondary">{t("advance.uploadHelp")}</p>
          <AdvanceFileForm
            orgId=""
            recipientId=""
            sectionId={section.id}
            maxFiles={section.maxLines ?? 1}
            label={section.title}
            actions={{ upload: withAdvanceLink(link, uploadAdvanceTokenFileAction, onAnswered) }}
          />
        </>
      ) : null;
    case "Schedule Window":
    case "Item Request":
    case "Credential Request":
      return open ? (
        <AdvanceLinesForm
          recipientId=""
          sectionId={section.id}
          kind={section.kind}
          label={section.title}
          timeZone={packet.timeZone}
          maxLines={section.maxLines ?? 1}
          perPerson={section.perPerson}
          items={section.choices.map((c) =>
            c.assetClassId
              ? { value: `asset_class:${c.assetClassId}`, label: c.className ?? "" }
              : {
                  value: `credential_category:${c.credentialCategoryId ?? ""}`,
                  label: c.categoryName ?? "",
                },
          )}
          people={section.rosterPeople.map((p) => ({
            value: p.rosterEntryId,
            label: p.displayName ?? t("advance.rosterUnnamed"),
          }))}
          actions={{ submit }}
        />
      ) : null;
    case "Guest List":
      return (
        <div className="flex flex-col gap-8">
          {section.guestsUsed !== null ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {section.guestCap === null
                ? tr("gateway.engagement.advance.guestsUsed", { n: section.guestsUsed })
                : tr("gateway.engagement.advance.guestsCap", {
                    n: section.guestsUsed,
                    cap: section.guestCap,
                  })}
            </p>
          ) : null}
          <TokenGuestForm sectionId={section.id} link={link} />
          {open ? (
            <GuestListConfirmForm
              recipientId=""
              sectionId={section.id}
              label={section.title}
              timeZone={packet.timeZone}
              actions={{ submit }}
            />
          ) : null}
        </div>
      );
    case "Crew Roster":
      return <TokenRoster section={section} packet={packet} link={link} />;
    default:
      return null;
  }
}

/** Asks for a guest through the link; the production approves or declines each one. */
function TokenGuestForm({ sectionId, link }: { sectionId: string; link: AdvanceLink }) {
  const t = useCopy();
  const tf = useFormCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    withAdvanceLink(link, requestTokenGuestAction),
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={tf("guest.submit")}
      doneLabel={tf("guest.done")}
      label={t("advance.guestsTitle")}
    >
      <input type="hidden" name="sectionId" value={sectionId} />
      <div className="flex flex-wrap gap-8">
        <Input
          id={`guest-name-${sectionId}`}
          name="guestName"
          required
          maxLength={200}
          label={tf("guest.name")}
        />
        <Input
          id={`guest-plus-ones-${sectionId}`}
          name="plusOnes"
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          defaultValue="0"
          label={tf("guest.plusOnes")}
        />
      </div>
      <MoreFields>
        <Textarea
          id={`guest-note-${sectionId}`}
          name="note"
          rows={2}
          maxLength={500}
          width="100%"
          label={tf("guest.note")}
        />
      </MoreFields>
    </FormShell>
  );
}

/**
 * The crew roster through the link: who is on it (a name once the person accepts, the invited
 * address masked before), an invitation by email, and the submit. The people invited accept their
 * own place after signing in (owner decision 6).
 */
function TokenRoster({
  section,
  packet,
  link,
}: {
  section: AdvanceSection;
  packet: AdvancePacket;
  link: AdvanceLink;
}) {
  const t = useCopy();
  const tf = useFormCopy();
  const tr = useTranslations() as unknown as Translate;
  const [roster, setRoster] = useState<TokenOutcome<readonly AdvanceRosterEntry[]> | null>(null);
  const [version, setVersion] = useState(0);
  const { token, accessCode } = link;
  useEffect(() => {
    let live = true;
    void listTokenRosterAction({ token, accessCode, sectionId: section.id }).then((next) => {
      if (live) setRoster(next);
    });
    return () => {
      live = false;
    };
  }, [token, accessCode, section.id, version]);
  const reload = () => setVersion((v) => v + 1);
  const [invited, invite, inviting] = useActionState<FormResult, FormData>(
    withAdvanceLink(link, inviteTokenRosterAction, reload),
    {},
  );
  const [submitted, submit, submitting] = useActionState<FormResult, FormData>(
    withAdvanceLink(link, submitTokenRosterAction, reload),
    {},
  );
  const entries = roster?.ok ? roster.data : [];
  return (
    <div className="flex flex-col gap-12">
      <h3 className="m-0 text-heading-16 font-semibold">{t("advance.rosterTitle")}</h3>
      <p className="m-0 text-text-13 text-text-secondary">{t("advance.rosterHelp")}</p>
      <Problem result={roster} />
      {roster?.ok && entries.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {tr("gateway.engagement.advance.rosterEmpty")}
        </p>
      ) : null}
      {entries.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-4 p-0 text-text-13"
          aria-label={t("advance.rosterTitle")}
        >
          {entries.map((e) => (
            <li key={e.rosterEntryId} className="break-words">
              {t("advance.rosterEntry", {
                name: e.displayName ?? t("advance.rosterUnnamed"),
                state: tr(enumLabelKey("rosterEntryState", e.entryState)),
              })}
              {e.invitationState
                ? ` · ${t(`advance.invitation.${enumKey(e.invitationState)}`)}`
                : null}
            </li>
          ))}
        </ul>
      ) : null}
      <FormShell
        row
        state={invited.done ? {} : invited}
        pending={inviting}
        action={invite}
        submitLabel={tf("roster.invite")}
        doneLabel={tf("roster.invited")}
        label={tf("roster.inviteTitle")}
      >
        <input type="hidden" name="sectionId" value={section.id} />
        <Input
          id={`token-roster-email-${section.id}`}
          name="email"
          type="email"
          required
          autoComplete="off"
          label={tf("roster.email")}
          help={tf("roster.emailHelp")}
        />
        <MoreFields>
          <div className="flex flex-wrap gap-12">
            <Input
              id={`token-roster-starts-${section.id}`}
              name="arrivalStartsAt"
              type="datetime-local"
              label={tf("roster.arrivalStarts")}
            />
            <Input
              id={`token-roster-ends-${section.id}`}
              name="arrivalEndsAt"
              type="datetime-local"
              label={tf("roster.arrivalEnds")}
            />
          </div>
          <input type="hidden" name="arrivalTimeZone" value={packet.timeZone} />
        </MoreFields>
      </FormShell>
      {invited.done ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {tf("roster.invited")}
        </p>
      ) : null}
      <FormShell
        row
        state={submitted}
        pending={submitting}
        action={submit}
        submitLabel={t("advance.rosterSubmit")}
        doneLabel={t("advance.rosterSubmitted")}
        label={t("advance.rosterSubmit")}
      >
        <input type="hidden" name="sectionId" value={section.id} />
        <p className="m-0 text-text-13 text-text-secondary">{t("advance.rosterSubmitHelp")}</p>
      </FormShell>
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
      <Header
        eyebrow={[doc.orgName, doc.projectName].filter(Boolean).join(" · ")}
        title={doc.title}
      >
        <p className="m-0 text-text-13 text-text-secondary">
          {t("sign.state", { state: tRoot(enumLabelKey("engagementDocumentState", doc.state)) })}
        </p>
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
            start(async () =>
              setSigned(
                await signDocumentTokenAction({ token, accessCode: code, signerName: name }),
              ),
            );
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
            <Button
              type="submit"
              variant="primary"
              icon="FileSignature"
              disabled={pending}
              aria-busy={pending}
            >
              {t("sign.submit")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
