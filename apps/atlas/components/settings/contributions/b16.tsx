import { listMcpConnectors, listMyAgentProposals } from "@xos/data/agent-proposals";
import { getBillingAccount, getSubscriptionPause } from "@xos/data/billing";
import { listBlocklist } from "@xos/data/member-blocklist";
import { dayOf } from "@xos/data/org-lifecycle";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  BlocklistAddForm,
  BlocklistRemove,
  McpConnectorForm,
  PauseForm,
  ProposalDecision,
  ResumeForm,
} from "@/components/settings/b16-forms";
import { Card, InlineAlert } from "@/components/ui";
import { billingStatus } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { RESTRICTED_GROUPS } from "@/lib/mcp/apply";
import { mcpHosted, mcpServerUrl } from "@/lib/mcp/connectors";
import { CAPABILITY_GROUPS } from "@/lib/mcp/metadata";
import { getFormatters } from "@/lib/platform/format";
import { getTranslate } from "@/lib/shell/translate";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * B16's settings panels (RRR-240, ADR 0155):
 *   - Settings, Members: the blocklist of email addresses and domains (3050), for org.members.manage.
 *   - Settings, Billing and Plan: pausing a monthly Stripe plan for 1 to 6 months, and resuming it (3051). Shown when
 *     billing is open and the org pays monthly through Stripe, or a pause is open; only the Owner acts.
 *   - Settings, Integrations: registering a Claude, ChatGPT or other MCP connector from a preset (3052).
 *   - Personal settings, Connected apps: the changes connected apps proposed, confirmed or rejected one at a time.
 * Every read runs with the viewer's session; the forms post to server actions the database decides.
 */

type T = (key: string, values?: Record<string, string | number>) => string;

async function copy(namespace: string): Promise<T> {
  return (await getTranslations(namespace)) as unknown as T;
}

function Section({
  id,
  title,
  description,
  testId,
  children,
}: {
  id: string;
  title: string;
  description: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <section
        id={id}
        aria-labelledby={`${id}-title`}
        className="flex flex-col gap-12"
        data-testid={testId}
      >
        <header className="flex flex-col gap-4">
          <h2 id={`${id}-title`} className="m-0 text-heading-16 font-semibold">
            {title}
          </h2>
          <p className="m-0 text-text-13 text-text-secondary">{description}</p>
        </header>
        {children}
      </section>
    </Card>
  );
}

// Blocklist ------------------------------------------------------------------------------------------------------

async function BlocklistPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.members.manage")) return null;
  const [t, entries, format] = await Promise.all([
    copy("memberBlocklist"),
    listBlocklist(ctx.viewer.db, ctx.org.id),
    getFormatters(ctx),
  ]);
  return (
    <Section
      id="member-blocklist"
      title={t("title")}
      description={t("description")}
      testId="blocklist-panel"
    >
      {!entries.ok ? (
        <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>
      ) : entries.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : (
        <ul
          aria-label={t("title")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {entries.data.map((e) => (
            <li
              key={e.entryId}
              className="flex flex-wrap items-start justify-between gap-12 py-12"
              data-testid="blocklist-entry"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-label-13 font-medium break-words">
                  {t(`kinds.${e.kind}`)}: {e.value}
                </span>
                {e.reason ? (
                  <span className="text-text-12 text-text-secondary break-words">{e.reason}</span>
                ) : null}
                <span className="text-text-12 text-text-secondary">
                  {e.createdByName
                    ? t("addedBy", { name: e.createdByName, date: format.date(e.createdAt) })
                    : t("addedOn", { date: format.date(e.createdAt) })}
                </span>
                <span className="text-text-12" data-testid="blocklist-matching">
                  {t("matching", { count: e.membersMatching })}
                </span>
              </div>
              <BlocklistRemove
                org={ctx.org.slug}
                entryId={e.entryId}
                labels={{
                  trigger: t("remove"),
                  title: t("removeTitle", { value: e.value }),
                  body: t("removeBody"),
                  cancel: t("cancel"),
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <BlocklistAddForm
        org={ctx.org.slug}
        labels={{
          kind: t("kind"),
          kinds: { Email: t("kinds.Email"), Domain: t("kinds.Domain") },
          value: t("value"),
          valueHelp: t("valueHelp"),
          reason: t("reason"),
          add: t("add"),
        }}
      />
    </Section>
  );
}

// Pause --------------------------------------------------------------------------------------------------------

const PAUSE_REFUSALS = [
  "pause_not_paid",
  "pause_trial",
  "pause_past_due",
  "pause_annual",
  "pause_open",
  "pause_months_range",
  "pause_period_unknown",
  "pause_not_active",
  "pause_none",
  "pause_needs_payment_method",
  "org_read_only",
  "sandbox_not_billable",
  "billing_through_partner",
  "billing_not_open",
  "step_up_required",
  "other",
] as const;

/** Whole months after an instant, counted in UTC as the database counts them (private.pause_resume_at). */
function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const out = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ),
  );
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out.toISOString();
}

async function PausePanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.billing.read")) return null;
  const status = billingStatus();
  if (!status.open) return null;
  const [t, account, pause, format, zone] = await Promise.all([
    copy("subscriptionPause"),
    getBillingAccount(ctx.viewer.db, ctx.org.id, status.livemode),
    getSubscriptionPause(ctx.viewer.db, ctx.org.id),
    getFormatters(ctx),
    getOrgTimeZone(ctx),
  ]);
  const open = pause.ok ? pause.data : null;
  const monthly =
    account.ok && account.data.paidThroughStripe && account.data.interval === "Monthly";
  if (!monthly && open === null) return null;
  const owner = ctx.capabilities.has("org.billing.manage");
  const day = (iso: string) => format.date(dayOf(iso, zone));
  const refusals = Object.fromEntries(PAUSE_REFUSALS.map((r) => [r, t(`refusals.${r}`)]));
  let body: ReactNode;
  if (open !== null) {
    const sentence = open.started
      ? open.resumesAt
        ? t("running", { resumesOn: day(open.resumesAt) })
        : t("runningOpen")
      : t("scheduled", {
          startsOn: day(open.startsAt),
          resumesOn: open.resumesAt ? day(open.resumesAt) : "",
        });
    body = (
      <>
        <p className="m-0 text-text-13" data-testid="pause-status">
          {sentence}
        </p>
        {owner ? (
          <ResumeForm
            org={ctx.org.slug}
            label={open.started ? t("resume") : t("cancelScheduled")}
            note={open.started ? t("resumeStarted") : null}
            done={t("resumed")}
            refusals={refusals}
          />
        ) : (
          <p className="m-0 text-text-12 text-text-secondary">{t("ownerOnly")}</p>
        )}
      </>
    );
  } else if (account.ok && account.data.currentPeriodEnd) {
    const end = account.data.currentPeriodEnd;
    const previews = [1, 2, 3, 4, 5, 6].map((m) =>
      t("preview", { startsOn: day(end), resumesOn: day(addMonths(end, m)) }),
    );
    body = owner ? (
      <PauseForm
        org={ctx.org.slug}
        previews={previews}
        labels={{
          months: t("months"),
          options: [1, 2, 3, 4, 5, 6].map((m) => t("monthsOption", { count: m })),
          pause: t("pause"),
          paused: t("paused", { startsOn: day(end) }),
        }}
        refusals={refusals}
      />
    ) : (
      <p className="m-0 text-text-12 text-text-secondary">{t("ownerOnly")}</p>
    );
  } else {
    body = (
      <p className="m-0 text-text-13 text-text-secondary">{t("refusals.pause_period_unknown")}</p>
    );
  }
  return (
    <Section
      id="subscription-pause"
      title={t("title")}
      description={t("description")}
      testId="pause-panel"
    >
      {body}
    </Section>
  );
}

// MCP connectors -----------------------------------------------------------------------------------------------

async function McpConnectorsPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.settings.read")) return null;
  const [t, translate, connectors] = await Promise.all([
    copy("mcpConnectors"),
    getTranslate(),
    listMcpConnectors(ctx.viewer.db, ctx.org.id),
  ]);
  const config = env();
  const groups = CAPABILITY_GROUPS.filter((g) => !RESTRICTED_GROUPS.has(g)).map((g) => ({
    value: g,
    label: translate(`authSecurity.scopes.${g}`),
  }));
  return (
    <Section
      id="mcp-connectors"
      title={t("title")}
      description={t("description")}
      testId="mcp-connectors-panel"
    >
      {mcpHosted(config) ? null : <InlineAlert tone="info">{t("off")}</InlineAlert>}
      <h3 className="m-0 text-label-14 font-semibold">{t("list")}</h3>
      {!connectors.ok || connectors.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("none")}</p>
      ) : (
        <ul
          aria-label={t("list")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {connectors.data.map((c) => (
            <li key={c.oauthAppId} className="flex flex-col gap-2 py-8 text-text-13">
              <span className="font-medium">
                {t("connectorName", { name: c.name, kind: t(`kinds.${c.kind}`) })}
              </span>
              <span className="text-text-12 text-text-secondary break-all">
                {t("serverUrl")}: {mcpServerUrl(config)}
              </span>
              {c.clientId ? (
                <span className="text-text-12 text-text-secondary break-all">
                  {t("clientId")}: {c.clientId}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {ctx.capabilities.has("org.integrations.manage") ? (
        <McpConnectorForm
          org={ctx.org.slug}
          groups={groups}
          defaults={groups.map((g) => g.value)}
          labels={{
            kind: t("kind"),
            kinds: {
              Claude: t("kinds.Claude"),
              ChatGPT: t("kinds.ChatGPT"),
              Other: t("kinds.Other"),
            },
            name: t("name"),
            redirect: t("redirect"),
            redirectHelp: t("redirectHelp"),
            scopes: t("scopes"),
            scopesHelp: t("scopesHelp"),
            register: t("register"),
            serverUrl: t("serverUrl"),
            clientId: t("clientId"),
            copy: t("copy"),
            copied: t("copied"),
            steps: {
              Claude: t("steps.Claude"),
              ChatGPT: t("steps.ChatGPT"),
              Other: t("steps.Other"),
            },
          }}
        />
      ) : null}
    </Section>
  );
}

// Proposals ----------------------------------------------------------------------------------------------------

/** The SDK's own summary of an operation, the action the person confirms; the app's note is shown apart. */
async function operationSummaries(): Promise<Readonly<Record<string, { summary: string }>>> {
  const { OPERATIONS } = await import("@ghxstship/xos-sdk");
  return OPERATIONS as unknown as Readonly<Record<string, { summary: string }>>;
}

function shown(value: unknown, clear: string): string {
  if (value === null) return clear;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function AgentProposalsPanel({ ctx }: SettingsPanelProps) {
  const [t, proposals, format, operations] = await Promise.all([
    copy("agentChanges"),
    listMyAgentProposals(ctx.viewer.db, ctx.org.id),
    getFormatters(ctx),
    operationSummaries(),
  ]);
  if (!proposals.ok)
    return <InlineAlert tone="danger">{t("refusals.other", { detail: "" })}</InlineAlert>;
  return (
    <Section
      id="agent-changes"
      title={t("title")}
      description={t("description")}
      testId="agent-changes-panel"
    >
      {proposals.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : (
        <ul
          aria-label={t("title")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {proposals.data.map((p) => (
            <li
              key={p.suggestionId}
              className="flex flex-col gap-8 py-12"
              data-testid="agent-proposal"
            >
              <div className="flex flex-col gap-2">
                <span className="text-label-13 font-medium">
                  {operations[p.operationId]?.summary ?? p.operationId}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("from", { app: p.appName })} ·{" "}
                  {t("expires", { date: format.dateTime(p.expiresAt) })}
                </span>
                {p.targetId ? (
                  <span className="text-text-12 text-text-secondary break-all">
                    {t("target")}: {p.targetId}
                  </span>
                ) : null}
                <span className="text-text-12 text-text-secondary break-words">
                  {t("note", { note: p.summary })}
                </span>
              </div>
              {p.fields.length === 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">{t("noFields")}</p>
              ) : (
                <dl className="m-0 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-12 gap-y-4 text-text-12">
                  {p.fields.map((f) => (
                    <div key={f.fieldPath} className="contents">
                      <dt className="font-medium break-all">{f.fieldPath}</dt>
                      <dd className="m-0 break-all">{shown(f.value, t("clear"))}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <ProposalDecision
                org={ctx.org.slug}
                suggestionId={p.suggestionId}
                labels={{ confirm: t("confirm"), reject: t("reject") }}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.members", order: 30, Panel: BlocklistPanel },
  // A107's plan limits hold order 10.
  { node: "settings.billing-and-plan", order: 20, Panel: PausePanel },
  { node: "settings.integrations", order: 45, Panel: McpConnectorsPanel },
  // A99's connected apps hold order 10.
  { node: "me.connected-apps", order: 20, Panel: AgentProposalsPanel },
];
