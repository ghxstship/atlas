"use client";

import { Button, Checkbox, InlineAlert, Input, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { OutcomeAlert } from "@/components/actions/action-button";
import {
  rateEngagementAction,
  replyToRatingAction,
  sendMessageAction,
  type MessageFormState,
  type RatingFormState,
} from "@/lib/actions/engagement";
import {
  answerAdvanceAction,
  decideApprovalAction,
  openThreadAction,
  submitDeliverableAction,
  submitInvoiceAction,
  submitTaxFormAction,
  uploadOnboardingAction,
  type FormResult,
} from "@/lib/actions/operations";

import { keepInputOnSubmit } from "@/components/forms/keep-input";
type Translate = (key: string, values?: Record<string, string | number>) => string;

export function useCopy(): Translate {
  return useTranslations("gateway.engagement.forms") as unknown as Translate;
}

/** Shared form chrome: field and outcome errors, a success line, refresh on success. */
export function FormShell({
  state,
  pending,
  submitLabel,
  doneLabel,
  children,
  action,
  label,
}: {
  state: FormResult;
  pending: boolean;
  submitLabel: string;
  doneLabel: string;
  children: ReactNode;
  action: (form: FormData) => void;
  label: string;
}) {
  const t = useCopy();
  const router = useRouter();
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state.done, router]);
  if (state.done)
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {doneLabel}
      </p>
    );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex w-full flex-col gap-12"
      aria-label={label}
    >
      {state.fieldError ? (
        <InlineAlert tone="danger">{t(`errors.${state.fieldError}`)}</InlineAlert>
      ) : null}
      <OutcomeAlert outcome={state.outcome} />
      {children}
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={pending} aria-busy={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function AdvanceAnswerForm(props: {
  recipientId: string;
  sectionId: string;
  prompt: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(answerAdvanceAction, {});
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("advance.submit")}
      doneLabel={t("advance.done")}
      label={props.prompt}
    >
      <input type="hidden" name="recipientId" value={props.recipientId} />
      <input type="hidden" name="sectionId" value={props.sectionId} />
      <Textarea
        id={`advance-${props.sectionId}`}
        name="body"
        required
        rows={3}
        width="100%"
        label={t("advance.answer")}
      />
    </FormShell>
  );
}

export function ApprovalForm(props: { requestId: string; subject: string }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(decideApprovalAction, {});
  const [decision, setDecision] = useState<"Approved" | "Rejected">("Approved");
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={decision === "Approved" ? t("approval.approve") : t("approval.reject")}
      doneLabel={t("approval.done")}
      label={props.subject}
    >
      <input type="hidden" name="requestId" value={props.requestId} />
      <input type="hidden" name="decision" value={decision} />
      <fieldset className="m-0 flex flex-wrap gap-8 border-0 p-0">
        <legend className="sr-only">{t("approval.decision")}</legend>
        {(["Approved", "Rejected"] as const).map((d) => (
          <Button
            key={d}
            type="button"
            size="sm"
            variant={decision === d ? "secondary" : "ghost"}
            aria-pressed={decision === d}
            onClick={() => setDecision(d)}
          >
            {d === "Approved" ? t("approval.approve") : t("approval.reject")}
          </Button>
        ))}
      </fieldset>
      <Textarea
        id={`approval-${props.requestId}`}
        name="response"
        rows={2}
        width="100%"
        label={decision === "Rejected" ? t("approval.reason") : t("approval.note")}
        required={decision === "Rejected"}
      />
    </FormShell>
  );
}

export function DeliverableForm(props: {
  deliverableId: string;
  title: string;
  documents: readonly { readonly id: string; readonly title: string }[];
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    submitDeliverableAction,
    {},
  );
  if (props.documents.length === 0)
    return <p className="m-0 text-text-13 text-text-secondary">{t("deliverable.noDocuments")}</p>;
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("deliverable.submit")}
      doneLabel={t("deliverable.done")}
      label={props.title}
    >
      <input type="hidden" name="deliverableId" value={props.deliverableId} />
      <label className="flex flex-col gap-4 text-text-13">
        <span className="font-medium">{t("deliverable.document")}</span>
        <select
          name="documentId"
          required
          className="min-h-touch-min rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
        >
          {props.documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </label>
      <Textarea
        id={`deliverable-${props.deliverableId}`}
        name="message"
        required
        rows={2}
        width="100%"
        label={t("deliverable.message")}
      />
    </FormShell>
  );
}

export function InvoiceForm(props: {
  engagementId: string;
  currency: string;
  suggestedNumber: string;
  today: string;
  due: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(submitInvoiceAction, {});
  const [lines, setLines] = useState([0]);
  const [next, setNext] = useState(1);
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("invoice.submit")}
      doneLabel={t("invoice.done")}
      label={t("invoice.title")}
    >
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <input type="hidden" name="currency" value={props.currency} />
      <div className="flex flex-wrap gap-8">
        <Input
          id="invoice-number"
          name="invoiceNumber"
          required
          label={t("invoice.number")}
          defaultValue={props.suggestedNumber}
        />
        <Input
          id="invoice-issued"
          name="issuedOn"
          type="date"
          required
          label={t("invoice.issuedOn")}
          defaultValue={props.today}
        />
        <Input
          id="invoice-due"
          name="dueOn"
          type="date"
          required
          label={t("invoice.dueOn")}
          defaultValue={props.due}
        />
      </div>
      <p className="m-0 text-text-12 text-text-secondary">
        {t("invoice.currency", { currency: props.currency })}
      </p>
      {lines.map((line, i) => (
        <div
          key={line}
          className="flex flex-wrap items-end gap-8 rounded-control bg-bg-surface p-8"
        >
          <Input
            id={`invoice-line-${line}-description`}
            name="lineDescription"
            required
            label={t("invoice.description")}
            width="100%"
          />
          <Input
            id={`invoice-line-${line}-quantity`}
            name="lineQuantity"
            inputMode="decimal"
            label={t("invoice.quantity")}
            width={120}
            defaultValue="1"
          />
          <Input
            id={`invoice-line-${line}-price`}
            name="linePrice"
            inputMode="decimal"
            required
            label={t("invoice.unitPrice")}
            width={160}
          />
          {lines.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLines(lines.filter((l) => l !== line))}
            >
              {t("invoice.removeLine", { n: i + 1 })}
            </Button>
          ) : null}
        </div>
      ))}
      <div>
        <Button
          type="button"
          size="sm"
          icon="Plus"
          onClick={() => {
            setLines([...lines, next]);
            setNext(next + 1);
          }}
        >
          {t("invoice.addLine")}
        </Button>
      </div>
    </FormShell>
  );
}

export function OnboardingUploadForm(props: {
  orgId: string;
  engagementId: string;
  itemId: string;
  name: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(uploadOnboardingAction, {});
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("upload.submit")}
      doneLabel={t("upload.done")}
      label={props.name}
    >
      <input type="hidden" name="orgId" value={props.orgId} />
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <input type="hidden" name="itemId" value={props.itemId} />
      <input type="hidden" name="title" value={props.name} />
      <label className="flex flex-col gap-4 text-text-13">
        <span className="font-medium">{t("upload.file")}</span>
        <input
          type="file"
          name="file"
          required
          accept="application/pdf,image/jpeg,image/png,image/heic,image/webp"
          capture="environment"
          className="min-h-touch-min text-text-13"
        />
        <span className="text-text-12 text-text-secondary">{t("upload.help")}</span>
      </label>
    </FormShell>
  );
}

export function TaxFormForm(props: {
  orgId: string;
  kinds: readonly { value: string; label: string }[];
  asAccount: boolean;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(submitTaxFormAction, {});
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("tax.submit")}
      doneLabel={t("tax.done")}
      label={t("tax.title")}
    >
      <input type="hidden" name="orgId" value={props.orgId} />
      <label className="flex flex-col gap-4 text-text-13">
        <span className="font-medium">{t("tax.kind")}</span>
        <select
          name="formKind"
          required
          className="min-h-touch-min rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
        >
          {props.kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <Input
        id={`tin-${props.orgId}`}
        name="tin"
        required
        autoComplete="off"
        inputMode="numeric"
        type="password"
        label={t("tax.tin")}
        help={t("tax.tinHelp")}
      />
      {!props.asAccount ? <Checkbox name="withholding" label={t("tax.withholding")} /> : null}
    </FormShell>
  );
}

export function NewThreadForm(props: { engagementId: string }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(openThreadAction, {});
  return (
    <FormShell
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("thread.submit")}
      doneLabel={t("thread.done")}
      label={t("thread.title")}
    >
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <Input
        id={`thread-${props.engagementId}`}
        name="subject"
        required
        label={t("thread.subject")}
        width="100%"
      />
    </FormShell>
  );
}

/** Reply in a thread; the composer clears after each message and the page refreshes. */
export function MessageComposer(props: { threadId: string; action?: "engagement" | "party" }) {
  const t = useCopy();
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<MessageFormState, FormData>(
    sendMessageAction,
    {},
  );
  useEffect(() => {
    if (state.sent) {
      ref.current?.reset();
      router.refresh();
    }
  }, [state.sent, router]);
  return (
    <form
      ref={ref}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8"
      aria-label={t("message.label")}
    >
      <OutcomeAlert outcome={state.outcome} />
      <input type="hidden" name="threadId" value={props.threadId} />
      <input type="hidden" name="kind" value={props.action ?? "engagement"} />
      <Textarea
        id={`composer-${props.threadId}`}
        name="body"
        required
        rows={2}
        width="100%"
        label={t("message.body")}
      />
      <div>
        <Button type="submit" variant="primary" icon="Send" disabled={pending} aria-busy={pending}>
          {t("message.send")}
        </Button>
      </div>
    </form>
  );
}

/** Rate the org after a completed engagement; both ratings release together (Section 4.4.3). */
export function RatingForm(props: { engagementId: string; org: string }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<RatingFormState, FormData>(
    rateEngagementAction,
    {},
  );
  const [score, setScore] = useState(0);
  if (state.done) return <InlineAlert tone="success">{t("rating.done")}</InlineAlert>;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      aria-label={t("rating.title", { org: props.org })}
    >
      <OutcomeAlert outcome={state.outcome} />
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <input type="hidden" name="score" value={score} />
      <div role="radiogroup" aria-label={t("rating.score")} className="flex gap-4">
        {[1, 2, 3, 4, 5].map((n) => (
          <Button
            key={n}
            type="button"
            size="sm"
            role="radio"
            aria-checked={score === n}
            variant={score >= n ? "secondary" : "ghost"}
            icon="Star"
            onClick={() => setScore(n)}
          >
            {t("rating.stars", { n })}
          </Button>
        ))}
      </div>
      <Textarea
        id={`rating-${props.engagementId}`}
        name="comment"
        rows={2}
        width="100%"
        label={t("rating.comment")}
      />
      <p className="m-0 text-text-12 text-text-secondary">{t("rating.release")}</p>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={pending || score === 0}
          aria-busy={pending}
        >
          {t("rating.submit")}
        </Button>
      </div>
    </form>
  );
}

export function ReplyForm(props: { ratingId: string }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<RatingFormState, FormData>(
    replyToRatingAction,
    {},
  );
  if (state.done)
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("reply.done")}
      </p>
    );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8"
      aria-label={t("reply.label")}
    >
      <OutcomeAlert outcome={state.outcome} />
      <input type="hidden" name="ratingId" value={props.ratingId} />
      <Textarea
        id={`reply-${props.ratingId}`}
        name="body"
        required
        rows={2}
        width="100%"
        label={t("reply.label")}
      />
      <div>
        <Button type="submit" size="sm" disabled={pending} aria-busy={pending}>
          {t("reply.submit")}
        </Button>
      </div>
    </form>
  );
}
