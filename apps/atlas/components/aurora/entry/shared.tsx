"use client";

import {
  createAuroraClient,
  type AuroraApiResult,
  type AuroraCall,
  type AuroraClient,
  type AuroraPreviewRecord,
  type AuroraProblem,
  type AuroraProposalSummary,
} from "@xos/ai/client";
import {
  ENTRY_TIMEOUT_MS,
  featureAvailability,
  problemKind,
  type FeatureAvailability,
} from "@xos/ai/entry";
import type { AiFeature } from "@xos/data/ai";
import { Drawer, InlineAlert, Link, RefusalNotice, Skeleton, Tag } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * What every Aurora entry point's panel shares (A95, finding A65-020): the client with the entry
 * point's wait, whether the feature can run now, the "what Aurora receives" list shown before
 * anything is sent, plain messages for a refusal, a timeout or a used-up allowance, the AI-generated
 * label (EU AI Act Article 50), and a live region that announces each result to screen readers.
 * Loaded only when a person opens an entry point, never with the page.
 */

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export function useEntryT(): Translate {
  return useTranslations("aurora.entry") as unknown as Translate;
}

export type Availability =
  | FeatureAvailability
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly problem: AuroraProblem };

/**
 * The client for one feature, and whether it can run now. Each opening mounts a fresh panel
 * (useEntryPanel keys it), so the check runs once per opening; `check` runs it again on request.
 */
export function useAurora(feature: AiFeature, open: boolean) {
  const client: AuroraClient = useMemo(
    () => createAuroraClient({ baseUrl: "/api/v1", timeoutMs: ENTRY_TIMEOUT_MS[feature] }),
    [feature],
  );
  const [availability, setAvailability] = useState<Availability>({ kind: "loading" });
  const load = useCallback(
    () =>
      client
        .status()
        .then((status) =>
          setAvailability(
            status.ok
              ? featureAvailability(status.data, feature)
              : { kind: "error", problem: status.problem },
          ),
        ),
    [client, feature],
  );
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const check = () => {
    setAvailability({ kind: "loading" });
    void load();
  };
  return { client, availability, check };
}

/** How one request ended, as an entry point shows it. */
export type Outcome<A> =
  | {
      readonly kind: "answer";
      readonly answer: A;
      readonly model: string | null;
      readonly suggestions: readonly AuroraProposalSummary[];
    }
  | { readonly kind: "no-answer"; readonly missing: string }
  | { readonly kind: "failed" }
  | { readonly kind: "problem"; readonly problem: AuroraProblem };

export function outcomeOf<A>(call: AuroraCall<AuroraApiResult<A>>): Outcome<A> {
  if (!call.ok) return { kind: "problem", problem: call.problem };
  const result = call.data;
  if (result.outcome === "no_answer") return { kind: "no-answer", missing: result.missing ?? "" };
  if (result.outcome === "failed" || result.answer === null) return { kind: "failed" };
  return {
    kind: "answer",
    answer: result.answer,
    model: result.model,
    suggestions: result.suggestions,
  };
}

/** The panel every entry point opens: a drawer that says what Aurora is before anything else. */
export function AiPanel({
  title,
  open,
  onOpenChange,
  footer,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = useEntryT();
  return (
    <Drawer title={title} open={open} onOpenChange={onOpenChange} footer={footer}>
      <p className="m-0 text-text-12 text-text-secondary">
        {t("notice")} <Link href="/legal/ai-features-notice">{t("noticeLink")}</Link>
      </p>
      {children}
    </Drawer>
  );
}

/** Why the feature cannot run, or nothing when it can. */
export function AvailabilityNotice({
  availability,
  onRetry,
}: {
  availability: Availability;
  onRetry: () => void;
}) {
  const t = useEntryT();
  switch (availability.kind) {
    case "loading":
      return (
        <div className="flex flex-col gap-8" aria-busy="true">
          <p role="status" className="m-0 text-text-13 text-text-secondary">
            {t("availability.loading")}
          </p>
          <Skeleton height={16} width="60%" />
        </div>
      );
    case "not-in-plan":
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("availability.notInPlanTitle")}
          reason={t("availability.notInPlan")}
        />
      );
    case "off":
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("availability.offTitle")}
          reason={t("availability.off")}
        />
      );
    case "limit-reached":
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("availability.limitTitle")}
          reason={t("availability.limit", { allowance: availability.allowance })}
        />
      );
    case "error":
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("availability.errorTitle")}
          reason={t("availability.error")}
          actionLabel={t("retry")}
          onAction={onRetry}
        />
      );
    default:
      return null;
  }
}

/** The catalog key of a problem kind: `not-in-plan` reads `problems.notInPlan`. */
export function problemKey(problem: AuroraProblem): string {
  return `problems.${problemKind(problem).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

/** The plain message for a request that did not answer: NO ANSWER, a failure or a problem. */
export function OutcomeNotice({ outcome }: { outcome: Outcome<unknown> }) {
  const t = useEntryT();
  if (outcome.kind === "answer") return null;
  if (outcome.kind === "no-answer") {
    return <RefusalNotice outcome="NO_ANSWER" title={t("noAnswer")} reason={outcome.missing} />;
  }
  if (outcome.kind === "failed") {
    return <InlineAlert tone="danger">{t("problems.failed")}</InlineAlert>;
  }
  const kind = problemKind(outcome.problem);
  return (
    <InlineAlert tone={kind === "timeout" || kind === "quota" ? "warning" : "danger"}>
      {t(problemKey(outcome.problem), { detail: outcome.problem.detail })}
    </InlineAlert>
  );
}

/** The text a screen reader hears for an outcome, announced by the panel's live region. */
export function outcomeAnnouncement(
  outcome: Outcome<unknown>,
  t: Translate,
  ready: string,
): string {
  if (outcome.kind === "answer") return ready;
  if (outcome.kind === "no-answer") return `${t("noAnswer")}. ${outcome.missing}`;
  if (outcome.kind === "failed") return t("problems.failed");
  return t(problemKey(outcome.problem), { detail: outcome.problem.detail });
}

/** A polite live region: results and errors are read out without moving focus. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

/** The EU AI Act label on every proposal, with the model that wrote it. */
export function AiGenerated({ model }: { model: string | null }) {
  const t = useEntryT();
  return (
    <span className="flex flex-wrap items-center gap-8 text-text-12 text-text-secondary">
      <Tag tone="accent">{t("aiLabel")}</Tag>
      {model ? <span>{t("modelLabel", { model })}</span> : null}
    </span>
  );
}

export interface SentItem {
  readonly label: string;
  readonly value: string;
}

/**
 * What Aurora receives, listed before the person sends anything: the items the entry point sends
 * and, for drafts and summaries, each record as aurora.preview reads it (fields sent, fields left
 * out). Restricted fields and medical records are never among them.
 */
export function SentList({
  items,
  records,
  recordLabel,
  vocabularyTerms,
}: {
  items: readonly SentItem[];
  records?: readonly AuroraPreviewRecord[] | "loading" | "error";
  recordLabel?: (record: AuroraPreviewRecord) => string;
  vocabularyTerms?: number;
}) {
  const t = useEntryT();
  return (
    <section aria-labelledby="ai-sent-heading" className="flex flex-col gap-8">
      <h3 id="ai-sent-heading" className="m-0 text-text-13 font-semibold">
        {t("sent.heading")}
      </h3>
      <dl className="m-0 flex flex-col gap-6 text-text-13">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col gap-2">
            <dt className="text-text-12 font-medium text-text-secondary">{item.label}</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{item.value}</dd>
          </div>
        ))}
      </dl>
      {records === "loading" ? (
        <p role="status" className="m-0 text-text-12 text-text-secondary">
          {t("sent.loading")}
        </p>
      ) : records === "error" ? (
        <InlineAlert tone="danger">{t("sent.error")}</InlineAlert>
      ) : records ? (
        <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
          {records.map((r, i) => (
            <li
              key={`${r.collection}-${r.id}-${i}`}
              className="flex flex-col gap-2 rounded-control border border-border-subtle p-8"
            >
              <span className="font-medium">{recordLabel ? recordLabel(r) : r.collection}</span>
              {r.sent ? (
                <>
                  <span className="text-text-12 text-text-secondary">
                    {t("sent.fields", { fields: r.fields.join(", ") })}
                  </span>
                  {r.withheld.length > 0 ? (
                    <span className="text-text-12 text-text-secondary">
                      {t("sent.withheld", { fields: r.withheld.join(", ") })}
                    </span>
                  ) : null}
                  <details className="text-text-12">
                    <summary className="cursor-pointer text-accent-text">
                      {t("sent.showData")}
                    </summary>
                    <pre className="m-0 mt-4 max-h-(--ui-listbox-max) overflow-auto whitespace-pre-wrap break-words rounded-control bg-bg-subtle p-8 text-text-12">
                      {JSON.stringify(r.data, null, 2)}
                    </pre>
                  </details>
                </>
              ) : (
                <span className="text-text-12 text-text-secondary">{t("sent.notSent")}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {vocabularyTerms !== undefined && vocabularyTerms > 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("sent.vocabulary", { count: vocabularyTerms })}
        </p>
      ) : null}
      <p className="m-0 text-text-12 text-text-secondary">{t("sent.restricted")}</p>
    </section>
  );
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isControl(element: unknown): element is Control {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

/**
 * Writes values into a form's own fields the way typing does, so React's handlers and the form's
 * submit see them. Nothing is saved: the person still submits the form (A95 rule "confirms before
 * writing"). A value given as a list fills same-named fields in order (repeated rows). Returns the
 * names it could not fill: no such field, or a select without that option.
 */
export function fillForm(
  form: HTMLFormElement,
  values: Readonly<Record<string, string | readonly string[]>>,
): string[] {
  const missing: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    const controls: Control[] =
      field instanceof RadioNodeList
        ? [...field].filter(isControl)
        : isControl(field)
          ? [field]
          : [];
    const list = typeof value === "string" ? [value] : value;
    if (controls.length < list.length) missing.push(name);
    list.forEach((v, i) => {
      const control = controls[i];
      if (!control) return;
      setValue(control, v);
      if (control.value !== v && !missing.includes(name)) missing.push(name);
    });
  }
  return missing;
}

/** Sets one control's value through the native setter and fires the events typing would. */
export function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
