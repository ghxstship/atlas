import { getLegalQueue, type LegalQueueItem } from "@xos/data/console-legal-queue";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { ActionForm } from "@/components/action-form";
import { ReasonField } from "@/components/fields";
import { LegalQueueAddForm } from "@/components/legal-queue-add-form";
import { Empty, PageHeader, Panel, Section, Table } from "@/components/page";
import { InlineAlert, Input, Tag } from "@/components/ui";
import {
  addLegalAlertContactAction,
  appointOutsideReviewerAction,
  endOutsideReviewerAction,
  removeLegalAlertContactAction,
} from "@/lib/actions/legal-queue";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("legalQueue.title") };
}

/**
 * The legal queue (ADR 0167): one list of legal and security work with its clock, so a one-person company does not miss
 * one because of a full inbox. Its one primary action adds an item; the sections below it read the counts the policies
 * promise, and name the two people who can stand behind the owner.
 */
export default async function LegalQueuePage({ searchParams }: PageProps<"/legal-queue">) {
  const ctx = await requirePermission("legal.queue");
  const closed = (await searchParams)["view"] === "closed";
  const format = await getConsoleFormat();
  const { t, label, instant, zoned, number } = format;
  const result = await getLegalQueue(ctx.db, !closed);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={t("legalQueue.title")} intro={t("legalQueue.intro")} />
        <InlineAlert tone="danger">{t("legalQueue.loadError")}</InlineAlert>
      </>
    );
  }
  const queue = result.data;
  const when = (iso: string | null) => zoned(iso, queue.timeZone);
  const { delivery } = queue;
  const stateCell = (item: LegalQueueItem) => (
    <span key="state" className="flex flex-wrap items-center gap-8">
      <span>{label("legalQueue.states", item.state)}</span>
      {item.customerClock ? <Tag>{t("legalQueue.customerClock")}</Tag> : null}
    </span>
  );
  return (
    <>
      <PageHeader title={t("legalQueue.title")} intro={t("legalQueue.intro")}>
        <p className="m-0 text-text-13" data-testid="legal-queue-summary">
          {t("legalQueue.summary", {
            open: number(queue.summary.open),
            overdue: number(queue.summary.overdue),
            dueSoon: number(queue.summary.dueSoon),
            zone: queue.timeZone,
          })}
        </p>
      </PageHeader>

      <div className="flex flex-col gap-8" data-testid="legal-queue-delivery">
        {delivery.stuck > 0 ? (
          <InlineAlert tone="danger">
            {t("legalQueue.delivery.stuck", { count: delivery.stuck })}
          </InlineAlert>
        ) : null}
        {delivery.failed > 0 ? (
          <InlineAlert tone="danger">
            {t("legalQueue.delivery.failed", { count: delivery.failed })}
          </InlineAlert>
        ) : null}
        {delivery.overdueWithoutAlert > 0 ? (
          <InlineAlert tone="danger">
            {t("legalQueue.delivery.noAlert", { count: delivery.overdueWithoutAlert })}
          </InlineAlert>
        ) : null}
        {delivery.webhookConfigured ? null : (
          <InlineAlert tone="info">{t("legalQueue.delivery.webhookOff")}</InlineAlert>
        )}
        {delivery.lastSentAt ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t("legalQueue.delivery.lastSent", { when: instant(delivery.lastSentAt) })}
          </p>
        ) : null}
      </div>

      <nav aria-label={t("legalQueue.title")}>
        <ul className="m-0 flex list-none gap-8 p-0">
          {[
            { href: "/legal-queue", current: !closed, text: t("legalQueue.openTab") },
            {
              href: "/legal-queue?view=closed",
              current: closed,
              text: t("legalQueue.closedTab"),
            },
          ].map((tab) => (
            <li key={tab.href}>
              <NextLink
                href={tab.href as Route}
                aria-current={tab.current ? "page" : undefined}
                className={`inline-flex h-control-md items-center rounded-control px-8 text-text-13 ${
                  tab.current ? "bg-bg-raised font-medium" : "text-accent-text underline"
                }`}
              >
                {tab.text}
              </NextLink>
            </li>
          ))}
        </ul>
      </nav>

      {queue.items.length === 0 ? (
        <Empty>{closed ? t("legalQueue.noneClosed") : t("legalQueue.none")}</Empty>
      ) : (
        <Table
          caption={closed ? t("legalQueue.closedTab") : t("legalQueue.openTab")}
          testId="legal-queue"
          columns={[
            t("legalQueue.columns.reference"),
            t("legalQueue.columns.matter"),
            t("legalQueue.columns.org"),
            t("legalQueue.columns.received"),
            closed ? t("legalQueue.columns.closed") : t("legalQueue.columns.next"),
            t("legalQueue.columns.state"),
          ]}
          rows={queue.items.map((item) => ({
            key: item.id,
            cells: [
              <span key="reference" className="flex flex-col gap-4">
                <NextLink
                  href={`/legal-queue/${item.id}` as Route}
                  className="font-medium text-accent-text underline"
                >
                  {item.reference}
                </NextLink>
                <span className="text-text-12 text-text-secondary">{item.title}</span>
              </span>,
              label("legalQueue.matters", item.matter),
              item.orgName ?? t("common.none"),
              when(item.receivedAt),
              closed ? (
                when(item.closedAt)
              ) : (
                <span key="clock" className="flex flex-wrap items-center gap-8">
                  <span>{when(item.nextClockAt)}</span>
                  {item.overdue ? <Tag tone="danger">{t("legalQueue.overdue")}</Tag> : null}
                </span>
              ),
              stateCell(item),
            ],
          }))}
        />
      )}

      <Section id="legal-add" title={t("legalQueue.add.title")} intro={t("legalQueue.add.intro")}>
        <Panel>
          <LegalQueueAddForm rules={queue.rules} />
        </Panel>
      </Section>

      <Section
        id="legal-repeat"
        title={t("legalQueue.repeat.title")}
        intro={t("legalQueue.repeat.intro")}
      >
        {queue.repeatInfringers.length === 0 ? (
          <Empty>{t("legalQueue.repeat.none")}</Empty>
        ) : (
          <Table
            caption={t("legalQueue.repeat.title")}
            testId="legal-repeat-infringers"
            columns={[
              t("legalQueue.repeat.person"),
              t("legalQueue.repeat.counted"),
              t("legalQueue.repeat.from"),
              t("legalQueue.repeat.status"),
            ]}
            rows={queue.repeatInfringers.map((r) => ({
              key: r.personId,
              cells: [
                r.name ?? t("common.unknownPerson"),
                number(r.counted),
                when(r.windowStart),
                r.thresholdMet ? t("legalQueue.repeat.met") : t("legalQueue.repeat.under"),
              ],
            }))}
          />
        )}
      </Section>

      <Section
        id="legal-government"
        title={t("legalQueue.government.title")}
        intro={t("legalQueue.government.intro")}
      >
        {queue.governmentRequests.length === 0 ? (
          <Empty>{t("legalQueue.government.none")}</Empty>
        ) : (
          <Table
            caption={t("legalQueue.government.title")}
            testId="legal-government"
            columns={[t("legalQueue.government.year"), t("legalQueue.government.received")]}
            rows={queue.governmentRequests.map((g) => ({
              key: String(g.year),
              cells: [String(g.year), number(g.received)],
            }))}
          />
        )}
      </Section>

      <Section
        id="legal-contacts"
        title={t("legalQueue.contacts.title")}
        intro={t("legalQueue.contacts.intro")}
      >
        {queue.contacts.length === 0 ? (
          <Empty>{t("legalQueue.contacts.none")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="legal-contacts-list">
            {queue.contacts.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-12 rounded-card border border-border-subtle p-12 text-text-13"
              >
                <span>
                  {c.name}, {c.email}
                </span>
                <ActionForm
                  action={removeLegalAlertContactAction}
                  hidden={{ contactId: c.id }}
                  submitLabel={t("legalQueue.contacts.remove")}
                  variant="secondary"
                  label={t("legalQueue.contacts.removeLabel", { name: c.name })}
                />
              </li>
            ))}
          </ul>
        )}
        <Panel>
          <ActionForm
            action={addLegalAlertContactAction}
            submitLabel={t("legalQueue.contacts.submit")}
            successLabel={t("legalQueue.contacts.done")}
            variant="secondary"
            label={t("legalQueue.contacts.submit")}
            testId="legal-contact-add"
          >
            <Input
              id="legal-contact-name"
              name="name"
              label={t("legalQueue.contacts.name")}
              maxLength={200}
              required
              width="100%"
            />
            <Input
              id="legal-contact-email"
              name="email"
              type="email"
              label={t("legalQueue.contacts.email")}
              required
              width="100%"
            />
          </ActionForm>
        </Panel>
      </Section>

      <Section id="legal-reviewer" title={t("legalQueue.reviewer.title")}>
        {queue.outsideReviewer ? (
          <Panel>
            <p className="m-0 text-text-13" data-testid="outside-reviewer">
              {queue.outsideReviewer.organization
                ? t("legalQueue.reviewer.currentOrg", {
                    name: queue.outsideReviewer.name,
                    organization: queue.outsideReviewer.organization,
                    when: when(queue.outsideReviewer.appointedAt),
                  })
                : t("legalQueue.reviewer.current", {
                    name: queue.outsideReviewer.name,
                    when: when(queue.outsideReviewer.appointedAt),
                  })}
            </p>
            <ActionForm
              action={endOutsideReviewerAction}
              hidden={{ reviewerId: queue.outsideReviewer.id }}
              submitLabel={t("legalQueue.reviewer.end")}
              successLabel={t("legalQueue.reviewer.ended")}
              variant="secondary"
              label={t("legalQueue.reviewer.end")}
            >
              <ReasonField t={t} id="legal-reviewer-end" label={t("legalQueue.reviewer.endReason")} />
            </ActionForm>
          </Panel>
        ) : (
          <Panel>
            <p className="m-0 max-w-prose text-text-13" data-testid="outside-reviewer">
              {t("legalQueue.reviewer.none")}
            </p>
            <ActionForm
              action={appointOutsideReviewerAction}
              submitLabel={t("legalQueue.reviewer.submit")}
              successLabel={t("legalQueue.reviewer.done")}
              variant="secondary"
              label={t("legalQueue.reviewer.submit")}
              testId="outside-reviewer-appoint"
            >
              <Input
                id="legal-reviewer-name"
                name="name"
                label={t("legalQueue.reviewer.name")}
                maxLength={200}
                required
                width="100%"
              />
              <Input
                id="legal-reviewer-organization"
                name="organization"
                label={t("legalQueue.reviewer.organization")}
                maxLength={200}
                width="100%"
              />
              <Input
                id="legal-reviewer-email"
                name="email"
                type="email"
                label={t("legalQueue.reviewer.email")}
                required
                width="100%"
              />
              <ReasonField t={t} id="legal-reviewer-reason" label={t("legalQueue.reviewer.reason")} />
            </ActionForm>
          </Panel>
        )}
      </Section>
    </>
  );
}
