"use client";

import { Button, InlineAlert, Input, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";
import {
  decideApprovalLinkAction,
  previewApprovalLinkAction,
  requestApprovalCodeAction,
  type SignedOutApprovalResult,
} from "@/lib/actions/one-tap";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The signed-out approval page of an outside approver (P9, ADR 0138; Section 7.5 invariant 8). The link alone shows
 * only what it does, for which org and to which masked address the code goes. "Email me a code" sends a 6-digit code;
 * the code shows the request and its step; the link's own action then decides it, a rejection with its reason. Wrong
 * codes say how many tries are left, and five lock the link. Nothing happens on opening the page.
 */
export function SignedOutApproval({
  token,
  action,
}: {
  token: string;
  action: "approve" | "reject";
}) {
  const t = useTranslations("gateway.auth.actionLink.signedOut") as unknown as Translate;
  const to = useTranslations("gateway.outcomes") as unknown as Translate;
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<SignedOutApprovalResult | null>(null);
  const [preview, setPreview] = useState<SignedOutApprovalResult | null>(null);

  const problem =
    result === null || result.outcome === "ok" || result.outcome === "code_sent"
      ? null
      : result.outcome === "refused"
        ? to(result.refusal ?? "unexpected")
        : t(`outcome.${result.outcome}`, { attemptsLeft: result.attemptsLeft ?? 0 });
  const finished =
    result?.outcome === "decided" ||
    result?.outcome === "approval_link_locked" ||
    result?.outcome === "notification_action_used" ||
    result?.outcome === "notification_action_expired" ||
    result?.outcome === "notification_action_invalid";

  if (result?.outcome === "decided")
    return <InlineAlert tone="success">{t(`done.${action}`)}</InlineAlert>;

  const requestCode = () =>
    start(async () => {
      const next = await requestApprovalCodeAction({ token });
      setResult(next);
      if (next.outcome === "code_sent") setSent(true);
    });

  return (
    <div className="flex flex-col gap-16">
      {problem ? <InlineAlert tone={finished ? "warning" : "danger"}>{problem}</InlineAlert> : null}
      {result?.outcome === "code_sent" ? (
        <InlineAlert tone="success">{t("codeSent")}</InlineAlert>
      ) : null}
      {finished ? null : !sent ? (
        <div className="flex flex-col gap-8">
          <p className="m-0 text-text-14 text-text-secondary">{t("codeIntro")}</p>
          <div>
            <Button variant="primary" onClick={requestCode} disabled={pending} aria-busy={pending}>
              {t("emailMeACode")}
            </Button>
          </div>
        </div>
      ) : preview?.outcome !== "ok" ? (
        <form
          className="flex flex-col gap-12"
          aria-label={t("codeLabel")}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            start(async () => {
              const next = await previewApprovalLinkAction({ token, code });
              setResult(next);
              if (next.outcome === "ok") setPreview(next);
            });
          }}
        >
          <Input
            id="approval-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            label={t("codeLabel")}
            help={t("codeHelp")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-12">
            <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
              {t("showRequest")}
            </Button>
            <Button variant="secondary" onClick={requestCode} disabled={pending}>
              {t("sendAgain")}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-12"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            start(async () => setResult(await decideApprovalLinkAction({ token, code, reason })));
          }}
        >
          <section
            aria-labelledby="approval-request"
            className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-16"
          >
            <h2 id="approval-request" className="m-0 text-heading-16 font-semibold">
              {preview.title ?? t("untitled")}
            </h2>
            {preview.stepName ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("step", { step: preview.stepName })}
              </p>
            ) : null}
          </section>
          {action === "reject" ? (
            <Textarea
              name="reason"
              label={t("reason")}
              required
              maxLength={2000}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          ) : null}
          <div>
            <Button
              type="submit"
              variant={action === "reject" ? "danger" : "primary"}
              disabled={pending}
              aria-busy={pending}
            >
              {t(`confirm.${action}`)}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
