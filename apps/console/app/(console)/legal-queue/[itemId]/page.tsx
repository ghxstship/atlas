import { getLegalQueueItem } from "@xos/data/console-legal-queue";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { Facts, PageHeader, Panel, Section } from "@/components/page";
import { Checkbox, InlineAlert, Select, Tag, Textarea } from "@/components/ui";
import {
  extendLegalQueueItemAction,
  moveLegalQueueItemAction,
  noteLegalQueueItemAction,
  recordLegalFirstResponseAction,
} from "@/lib/actions/legal-queue";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.legalQueueItem") };
}

/**
 * One legal queue item: what it is, what its clock rests on, the moves open to it and the log of what was done (ADR 0167).
 * A fed item is worked on its source and only takes notes here.
 */
export default async function LegalQueueItemPage({ params }: PageProps<"/legal-queue/[itemId]">) {
  const { itemId } = await params;
  if (!z.uuid().safeParse(itemId).success) notFound();
  const ctx = await requirePermission("legal.queue");
  const [detail, format] = await Promise.all([getLegalQueueItem(ctx.db, itemId), getConsoleFormat()]);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the legal queue item: ${detail.error.kind}`);
  }
  const item = detail.data;
  const { t, label, zoned, has } = format;
  const when = (iso: string | null) => zoned(iso, item.timeZone);
  const open = item.closedAt === null;
  const firstWaiting = open && item.firstResponseDueAt !== null && item.firstResponseAt === null;
  const facts: { label: string; value: string }[] = [
    { label: t("legalQueue.facts.matter"), value: label("legalQueue.matters", item.matter) },
    {
      label: t("legalQueue.facts.rule"),
      value: has(`legalQueue.rules.${item.ruleCode}.label`)
        ? t(`legalQueue.rules.${item.ruleCode}.label`)
        : item.ruleCode,
    },
    { label: t("legalQueue.facts.basis"), value: label("legalQueue.bases", item.basis) },
    {
      label: t("legalQueue.facts.source"),
      value: has(`legalQueue.rules.${item.ruleCode}.source`)
        ? t(`legalQueue.rules.${item.ruleCode}.source`)
        : t("common.none"),
    },
    { label: t("legalQueue.facts.state"), value: label("legalQueue.states", item.state) },
    ...(item.orgName ? [{ label: t("legalQueue.facts.org"), value: item.orgName }] : []),
    { label: t("legalQueue.facts.received"), value: when(item.receivedAt) },
    ...(item.firstResponseDueAt
      ? [{ label: t("legalQueue.facts.firstDue"), value: when(item.firstResponseDueAt) }]
      : []),
    ...(item.firstResponseAt
      ? [{ label: t("legalQueue.facts.firstDone"), value: when(item.firstResponseAt) }]
      : []),
    ...(item.earliestActionAt
      ? [{ label: t("legalQueue.facts.earliest"), value: when(item.earliestActionAt) }]
      : []),
    { label: t("legalQueue.facts.due"), value: when(item.dueAt) },
    ...(item.extendedAt
      ? [
          { label: t("legalQueue.facts.extended"), value: when(item.extendedAt) },
          { label: t("legalQueue.facts.extensionReason"), value: item.extensionReason ?? "" },
        ]
      : []),
    ...(item.requesterContact
      ? [{ label: t("legalQueue.facts.contact"), value: item.requesterContact }]
      : []),
    ...(item.subjectName ? [{ label: t("legalQueue.facts.subject"), value: item.subjectName }] : []),
    ...(item.details ? [{ label: t("legalQueue.facts.details"), value: item.details }] : []),
    ...(item.courtActionFiled
      ? [{ label: t("legalQueue.facts.courtAction"), value: t("common.yes") }]
      : []),
    ...(item.closedAt ? [{ label: t("legalQueue.facts.closed"), value: when(item.closedAt) }] : []),
  ];
  const canMove = open && !item.fed && item.nextStates.length > 0;
  return (
    <>
      <PageHeader title={`${item.reference}: ${item.title}`}>
        {item.overdue ? (
          <span>
            <Tag tone="danger">{t("legalQueue.overdue")}</Tag>
          </span>
        ) : null}
      </PageHeader>

      {item.customerClock ? (
        <InlineAlert tone="info">{t("legalQueue.customerNote")}</InlineAlert>
      ) : item.fed ? (
        <InlineAlert tone="info">{t("legalQueue.fedNote")}</InlineAlert>
      ) : null}
      {open && item.earliestActionAt && !item.courtActionFiled ? (
        <InlineAlert tone="warning">
          {t("legalQueue.earliestNote", { when: when(item.earliestActionAt) })}
        </InlineAlert>
      ) : null}

      <Panel>
        <Facts items={facts} />
        {item.relatedId && item.relatedReference ? (
          <p className="m-0 text-text-13">
            {t("legalQueue.facts.related")}:{" "}
            <NextLink
              href={`/legal-queue/${item.relatedId}` as Route}
              className="text-accent-text underline"
            >
              {item.relatedReference}
            </NextLink>
          </p>
        ) : null}
        {item.opportunityId ? (
          <p className="m-0 text-text-13">
            <NextLink
              href={`/moderation/${item.opportunityId}` as Route}
              className="text-accent-text underline"
            >
              {t("legalQueue.listingLink")}
            </NextLink>
          </p>
        ) : null}
      </Panel>

      {canMove ? (
        <Section id="legal-move" title={t("legalQueue.move.title")}>
          <Panel>
            <ActionForm
              action={moveLegalQueueItemAction}
              hidden={{ itemId: item.id, expected: item.state }}
              submitLabel={t("legalQueue.move.submit")}
              successLabel={t("legalQueue.move.done")}
              label={t("legalQueue.move.title")}
              testId="legal-move"
            >
              <Select
                id="legal-move-next"
                name="next"
                label={t("legalQueue.move.next")}
                value={item.nextStates[0] ?? ""}
                options={item.nextStates.map((s) => ({
                  value: s,
                  label: label("legalQueue.states", s),
                }))}
              />
              <Textarea
                id="legal-move-reason"
                name="reason"
                label={t("legalQueue.move.reason")}
                maxLength={4000}
                rows={2}
                required
                width="100%"
              />
              {item.matter === "DMCA Counter-Notice" ? (
                <Checkbox
                  id="legal-move-court"
                  name="courtActionFiled"
                  label={t("legalQueue.move.court")}
                />
              ) : null}
            </ActionForm>
          </Panel>
        </Section>
      ) : null}

      {firstWaiting ? (
        <Section id="legal-first" title={t("legalQueue.first.title")}>
          <Panel>
            <ActionForm
              action={recordLegalFirstResponseAction}
              hidden={{ itemId: item.id }}
              submitLabel={t("legalQueue.first.submit")}
              successLabel={t("legalQueue.first.done")}
              variant="secondary"
              label={t("legalQueue.first.title")}
              testId="legal-first"
            >
              <Textarea
                id="legal-first-note"
                name="note"
                label={t("legalQueue.first.note")}
                maxLength={4000}
                rows={2}
                required
                width="100%"
              />
            </ActionForm>
          </Panel>
        </Section>
      ) : null}

      {item.extendable ? (
        <Section id="legal-extend" title={t("legalQueue.extend.title")}>
          <Panel>
            <ActionForm
              action={extendLegalQueueItemAction}
              hidden={{ itemId: item.id }}
              submitLabel={t("legalQueue.extend.submit")}
              successLabel={t("legalQueue.extend.done")}
              variant="secondary"
              label={t("legalQueue.extend.title")}
              testId="legal-extend"
            >
              <Textarea
                id="legal-extend-reason"
                name="reason"
                label={t("legalQueue.extend.reason")}
                help={t("legalQueue.extend.help")}
                maxLength={1000}
                rows={2}
                required
                width="100%"
              />
            </ActionForm>
          </Panel>
        </Section>
      ) : null}

      <Section id="legal-note" title={t("legalQueue.note.title")}>
        <Panel>
          <ActionForm
            action={noteLegalQueueItemAction}
            hidden={{ itemId: item.id }}
            submitLabel={t("legalQueue.note.submit")}
            successLabel={t("legalQueue.note.done")}
            variant="secondary"
            label={t("legalQueue.note.title")}
            testId="legal-note"
          >
            <Textarea
              id="legal-note-text"
              name="note"
              label={t("legalQueue.note.note")}
              maxLength={4000}
              rows={2}
              required
              width="100%"
            />
          </ActionForm>
        </Panel>
      </Section>

      <Section id="legal-log" title={t("legalQueue.logTitle")}>
        <ol className="m-0 flex list-none flex-col gap-8 p-0" data-testid="legal-log">
          {item.events.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-4 rounded-card border border-border-subtle p-12 text-text-13"
            >
              <span className="font-medium">
                {t("legalQueue.logBy", {
                  what: label("legalQueue.events", e.kind),
                  when: when(e.at),
                  who: e.actorName ?? t("legalQueue.system"),
                })}
              </span>
              {e.fromState && e.toState ? (
                <span className="text-text-12 text-text-secondary">
                  {t("legalQueue.stateChange", {
                    from: label("legalQueue.states", e.fromState),
                    to: label("legalQueue.states", e.toState),
                  })}
                </span>
              ) : null}
              {e.note ? <span className="whitespace-pre-line">{e.note}</span> : null}
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
