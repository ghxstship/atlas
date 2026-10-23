"use client";

import type { AuroraBuiltFilter } from "@xos/ai/client";
import { Button, IconButton, InlineAlert, Input, Select } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  applyConditions,
  catalogForApi,
  describeCondition,
  fits,
  type AskCatalog,
  type AskCondition,
} from "@/lib/aurora/ask";
import {
  AiGenerated,
  AiPanel,
  AvailabilityNotice,
  LiveRegion,
  OutcomeNotice,
  outcomeAnnouncement,
  outcomeOf,
  SentList,
  useAurora,
  useEntryT,
  type Outcome,
} from "./shared";

type Phase =
  | { readonly kind: "compose" }
  | { readonly kind: "sending" }
  | { readonly kind: "done"; readonly outcome: Outcome<AuroraBuiltFilter> };

/**
 * Ask in plain language (Section 4.7, A95). The panel lists what Aurora receives: the sentence and
 * the page's own filters (names, values and meanings, never a record), with dates read on the org's
 * calendar. Aurora answers with conditions over those filters only; the person edits or removes any
 * of them, then applies them to the page. Nothing is saved: Aurora's proposal to save a view is
 * rejected, and the person can save the filtered page from the Saved views menu.
 */
export function AskDialog({
  catalog,
  sentence: asked,
  open,
  onOpenChange,
}: {
  catalog: AskCatalog;
  sentence: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useEntryT();
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();
  const { client, availability, check } = useAurora("plain_language", open);
  const [sentence, setSentence] = useState(asked);
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const [conditions, setConditions] = useState<readonly AskCondition[]>([]);
  const [announcement, setAnnouncement] = useState("");

  const answer = phase.kind === "done" && phase.outcome.kind === "answer" ? phase.outcome : null;
  const suggestion = answer?.suggestions[0]?.suggestion_id ?? null;

  const send = async () => {
    setPhase({ kind: "sending" });
    setAnnouncement(t("sending"));
    const outcome = outcomeOf(
      await client.filter({
        sentence: sentence.trim(),
        collections: [catalog.collection],
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        fields: catalogForApi(catalog),
      }),
    );
    if (outcome.kind === "answer") setConditions(outcome.answer.conditions);
    setPhase({ kind: "done", outcome });
    setAnnouncement(
      outcomeAnnouncement(
        outcome,
        t,
        outcome.kind === "answer"
          ? t("ask.ready", {
              filters: outcome.answer.conditions
                .map((c) => describeCondition(catalog, c))
                .join("; "),
            })
          : "",
      ),
    );
  };

  const settle = async (reason: string) => {
    if (suggestion) await client.reject(suggestion, reason);
  };

  const apply = async () => {
    const { query } = applyConditions(
      catalog,
      new URLSearchParams(window.location.search),
      conditions,
    );
    await settle(t("ask.appliedReason"));
    onOpenChange(false);
    router.replace((query ? `${pathname}?${query}` : pathname) as Route, { scroll: false });
    setAnnouncement(
      t("ask.applied", {
        filters: conditions.map((c) => describeCondition(catalog, c)).join("; ") || t("ask.none"),
      }),
    );
  };

  const discard = async () => {
    await settle(t("ask.discardReason"));
    onOpenChange(false);
    setAnnouncement(t("ask.discarded"));
  };

  const skipped = conditions.filter((c) => !fits(catalog, c));
  const ready = availability.kind === "ready";

  return (
    <>
      <LiveRegion message={announcement} />
      <AiPanel
        title={t("ask.title", { collection: catalog.label })}
        open={open}
        onOpenChange={onOpenChange}
        footer={
          answer ? (
            <>
              <Button variant="ghost" onClick={() => void discard()}>
                {t("discard")}
              </Button>
              <Button variant="primary" disabled={skipped.length > 0} onClick={() => void apply()}>
                {t("ask.apply")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button
                variant="primary"
                icon="Sparkles"
                loading={phase.kind === "sending"}
                disabled={!ready || sentence.trim() === "" || phase.kind === "sending"}
                onClick={() => void send()}
              >
                {t("send")}
              </Button>
            </>
          )
        }
      >
        <AvailabilityNotice availability={availability} onRetry={() => void check()} />
        {answer ? (
          <div className="flex flex-col gap-12">
            <AiGenerated model={answer.model} />
            <p className="m-0 text-text-13">{t("ask.built", { sentence: sentence.trim() })}</p>
            {conditions.length === 0 ? (
              <InlineAlert tone="info">{t("ask.everything")}</InlineAlert>
            ) : (
              <ul
                className="m-0 flex list-none flex-col gap-8 p-0"
                aria-label={t("ask.conditions")}
              >
                {conditions.map((c, i) => (
                  <li key={`${c.field}-${i}`} className="flex flex-wrap items-end gap-8">
                    <ConditionEditor
                      id={`${id}-${i}`}
                      catalog={catalog}
                      condition={c}
                      onChange={(value) =>
                        setConditions((all) => all.map((x, j) => (j === i ? { ...x, value } : x)))
                      }
                    />
                    <IconButton
                      icon="X"
                      label={t("ask.remove", { filter: describeCondition(catalog, c) })}
                      onClick={() => setConditions((all) => all.filter((_, j) => j !== i))}
                    />
                  </li>
                ))}
              </ul>
            )}
            {skipped.length > 0 ? (
              <InlineAlert tone="warning">
                {t("ask.skipped", {
                  filters: skipped.map((c) => describeCondition(catalog, c)).join("; "),
                })}
              </InlineAlert>
            ) : null}
            <p className="m-0 text-text-12 text-text-secondary">
              {t("ask.saveTip", { name: answer.answer.name })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-12">
            <Input
              id={`${id}-sentence`}
              label={t("ask.label")}
              width="100%"
              maxLength={500}
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
            />
            <SentList
              items={[
                { label: t("ask.sentSentence"), value: sentence.trim() },
                {
                  label: t("ask.sentFilters", { collection: catalog.label }),
                  value: catalog.fields
                    .map((f) =>
                      f.type === "enum" && f.values
                        ? `${f.label} (${f.values.map((v) => v.label).join(", ")})`
                        : f.label,
                    )
                    .join("\n"),
                },
                { label: t("ask.sentCalendar"), value: t("ask.calendar") },
              ]}
            />
            {phase.kind === "sending" ? (
              <p role="status" className="m-0 text-text-13 text-text-secondary">
                {t("sending")}
              </p>
            ) : null}
            {phase.kind === "done" ? <OutcomeNotice outcome={phase.outcome} /> : null}
          </div>
        )}
      </AiPanel>
    </>
  );
}

/** One condition's value, edited with the control its filter takes. */
function ConditionEditor({
  id,
  catalog,
  condition,
  onChange,
}: {
  id: string;
  catalog: AskCatalog;
  condition: AskCondition;
  onChange: (value: string) => void;
}) {
  const field = catalog.fields.find((f) => f.name === condition.field);
  const label = field?.label ?? condition.field;
  if (field && (field.type === "enum" || field.type === "boolean") && field.values) {
    return (
      <Select
        id={id}
        label={label}
        value={condition.value}
        options={field.values.map((v) => ({ value: v.value, label: v.label }))}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Input
      id={id}
      label={label}
      type={field?.type === "date" ? "date" : "text"}
      value={condition.value}
      maxLength={200}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
