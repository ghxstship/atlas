import type { ReactElement } from "react";
import { Button, Link, Section, Text } from "@react-email/components";
import type { Locale } from "@xos/i18n";
import { EMAIL_ACTIONS, type EmailAction } from "../actions.ts";
import type { MessageArgs, Translate } from "../messages.ts";
import { color, radius, space, stroke, text } from "../theme.ts";
import { Layout, Paragraph, type Sender } from "./layout.tsx";

/** What every template receives besides its own props. */
export interface TemplateContext {
  readonly locale: Locale;
  readonly t: Translate;
  readonly sender: Sender;
  readonly recipientName: string;
}

export interface Composed {
  readonly subject: string;
  readonly element: ReactElement;
}

/** One kind-driven item, as notifications and digests carry them. */
export interface KindItem {
  /** Notification kind, for example approval.requested; copy lives at email.kinds.{kind}. */
  readonly kind: string;
  readonly args: MessageArgs;
  readonly url: string;
  /**
   * One-tap actions (A127, ADR 0086): signed, single-use links to the confirm page of each action the item's Inbox
   * entry offers. A link never acts by itself; the confirm page asks, and a rejection asks for the reason.
   */
  readonly actions?: readonly EmailAction[];
}

export interface TemplateProps {
  readonly notification: KindItem;
  readonly digest: { readonly frequency: "daily" | "weekly"; readonly items: readonly KindItem[] };
  readonly invite: {
    readonly inviterName: string;
    readonly roleName: string;
    readonly acceptUrl: string;
    readonly expiresAt: Date;
  };
  readonly report_delivery: {
    readonly reportName: string;
    readonly periodLabel: string;
    readonly format: string;
    readonly url: string;
  };
  readonly export_ready: {
    readonly exportName: string;
    readonly expiresAt: Date;
    readonly url: string;
  };
  readonly import_finished: {
    readonly importName: string;
    /**
     * validated: the rows are checked and wait for review (written counts the rows ready to write, refused those to
     * fix); committed, the default: the batch is written (A104, migration 2051).
     */
    readonly stage?: "validated" | "committed";
    readonly written: number;
    readonly refused: number;
    readonly skipped: number;
    readonly url: string;
  };
  readonly dsar_received: {
    readonly requestType: string;
    readonly receivedAt: Date;
    readonly dueAt: Date;
  };
  /** Double opt-in for Subprocessor List change notices (Section 14.4, migration 1382). */
  readonly subprocessor_confirm: {
    readonly confirmUrl: string;
  };
  /** A Subprocessor List change notice, at least 30 days ahead (legal/subprocessors.md section 1). */
  readonly subprocessor_notice: {
    readonly listVersion: string;
    readonly summary: string;
    readonly effectiveOn: Date;
    readonly listUrl: string;
  };
}

export type TemplateCode = keyof TemplateProps;

interface Template<P> {
  /** Transactional email carries no unsubscribe link (CAN-SPAM and CASL). Matches private.email_templates. */
  readonly transactional: boolean;
  readonly compose: (props: P, ctx: TemplateContext) => Composed;
}

function kindKey(kind: string, part: "subject" | "body"): string {
  if (!/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(kind))
    throw new Error(`Invalid notification kind ${kind}`);
  return `kinds.${kind}.${part}`;
}

/**
 * The one-tap action buttons (A127): each opens the confirm page, so acting from an email takes two taps. Approve and
 * accept are filled; reject is outlined, after them.
 */
function ActionLinks({
  actions,
  t,
}: {
  readonly actions: readonly EmailAction[];
  readonly t: Translate;
}) {
  const ordered = EMAIL_ACTIONS.flatMap((name) => actions.filter((a) => a.action === name));
  if (ordered.length === 0) return null;
  return (
    <Section>
      <Text style={{ margin: `0 0 ${space("space-16")}` }}>
        {ordered.flatMap((a, index) => [
          index > 0 ? " " : null,
          <Button
            key={a.action}
            href={a.url}
            style={a.action === "reject" ? actionStyles.secondary : actionStyles.primary}
          >
            {t(`notification.actions.${a.action}`)}
          </Button>,
        ])}
      </Text>
      <Text style={actionStyles.note}>{t("notification.actions.note")}</Text>
    </Section>
  );
}

const actionStyles = {
  primary: {
    ...text("label-13"),
    backgroundColor: color("accent-default"),
    border: `${stroke("stroke-hairline")} solid ${color("accent-default")}`,
    borderRadius: radius("radius-control"),
    color: color("accent-text-on"),
    padding: `${space("space-12")} ${space("space-20")}`,
    textDecoration: "none",
  },
  secondary: {
    ...text("label-13"),
    backgroundColor: color("bg-raised"),
    border: `${stroke("stroke-hairline")} solid ${color("border-control")}`,
    borderRadius: radius("radius-control"),
    color: color("text-primary"),
    padding: `${space("space-12")} ${space("space-20")}`,
    textDecoration: "none",
  },
  note: { ...text("text-12"), color: color("text-secondary"), margin: `0 0 ${space("space-16")}` },
} as const;

function Greeting({ ctx }: { readonly ctx: TemplateContext }) {
  return <Paragraph>{ctx.t("common.greeting", { name: ctx.recipientName })}</Paragraph>;
}

export const templates: { readonly [C in TemplateCode]: Template<TemplateProps[C]> } = {
  notification: {
    transactional: false,
    compose: (item, ctx) => {
      const subject = ctx.t(kindKey(item.kind, "subject"), item.args);
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("notification.heading", { subject })}
            transactional={false}
            action={{ label: ctx.t("common.open"), url: item.url }}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t(kindKey(item.kind, "body"), item.args)}</Paragraph>
            <ActionLinks actions={item.actions ?? []} t={ctx.t} />
          </Layout>
        ),
      };
    },
  },
  digest: {
    transactional: false,
    compose: ({ frequency, items }, ctx) => {
      if (items.length === 0) throw new Error("A digest needs at least one item");
      const subject = ctx.t("digest.subject", { count: items.length, orgName: ctx.sender.orgName });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("digest.heading", { frequency })}
            transactional={false}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("digest.intro", { orgName: ctx.sender.orgName })}</Paragraph>
            <Section>
              <ul
                style={{
                  margin: `0 0 ${space("space-16")}`,
                  paddingInlineStart: space("space-20"),
                }}
              >
                {items.map((item, index) => (
                  <li key={`${item.kind}-${index}`}>
                    <Text
                      style={{
                        ...text("text-14"),
                        color: color("text-primary"),
                        margin: `0 0 ${space("space-8")}`,
                      }}
                    >
                      <Link href={item.url} style={{ color: color("accent-text") }}>
                        {ctx.t(kindKey(item.kind, "subject"), item.args)}
                      </Link>
                    </Text>
                  </li>
                ))}
              </ul>
            </Section>
          </Layout>
        ),
      };
    },
  },
  invite: {
    transactional: true,
    compose: ({ inviterName, roleName, acceptUrl, expiresAt }, ctx) => {
      const args = { inviterName, roleName, orgName: ctx.sender.orgName };
      const subject = ctx.t("invite.subject", args);
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("invite.heading", args)}
            transactional
            action={{ label: ctx.t("invite.accept"), url: acceptUrl }}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("invite.body", args)}</Paragraph>
            <Paragraph>{ctx.t("invite.expires", { expiresAt })}</Paragraph>
          </Layout>
        ),
      };
    },
  },
  report_delivery: {
    transactional: false,
    compose: ({ reportName, periodLabel, format, url }, ctx) => {
      const subject = ctx.t("report_delivery.subject", { reportName, periodLabel });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("report_delivery.heading", { reportName })}
            transactional={false}
            action={{ label: ctx.t("common.open"), url }}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("report_delivery.body", { periodLabel, format })}</Paragraph>
            <Paragraph>
              {ctx.t("report_delivery.membersOnly", { orgName: ctx.sender.orgName })}
            </Paragraph>
          </Layout>
        ),
      };
    },
  },
  export_ready: {
    transactional: true,
    compose: ({ exportName, expiresAt, url }, ctx) => {
      const subject = ctx.t("export_ready.subject", { exportName });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("export_ready.heading")}
            transactional
            action={{ label: ctx.t("export_ready.download"), url }}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("export_ready.body", { exportName, expiresAt })}</Paragraph>
          </Layout>
        ),
      };
    },
  },
  import_finished: {
    transactional: true,
    compose: ({ importName, stage = "committed", written, refused, skipped, url }, ctx) => {
      const subject = ctx.t("import_finished.subject", { importName, stage });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("import_finished.heading", { stage })}
            transactional
            action={{ label: ctx.t("import_finished.review"), url }}
          >
            <Greeting ctx={ctx} />
            <Paragraph>
              {ctx.t("import_finished.body", { stage, written, refused, skipped })}
            </Paragraph>
          </Layout>
        ),
      };
    },
  },
  dsar_received: {
    transactional: true,
    compose: ({ requestType, receivedAt, dueAt }, ctx) => {
      const subject = ctx.t("dsar_received.subject", { requestType });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("dsar_received.heading")}
            transactional
          >
            <Greeting ctx={ctx} />
            <Paragraph>
              {ctx.t("dsar_received.body", {
                orgName: ctx.sender.orgName,
                requestType,
                receivedAt,
                dueAt,
              })}
            </Paragraph>
          </Layout>
        ),
      };
    },
  },
  subprocessor_confirm: {
    transactional: true,
    compose: ({ confirmUrl }, ctx) => {
      const subject = ctx.t("subprocessor_confirm.subject");
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("subprocessor_confirm.heading")}
            transactional
            action={{ label: ctx.t("subprocessor_confirm.confirm"), url: confirmUrl }}
          >
            <Paragraph>{ctx.t("subprocessor_confirm.body")}</Paragraph>
            <Paragraph>{ctx.t("subprocessor_confirm.ignore")}</Paragraph>
          </Layout>
        ),
      };
    },
  },
  subprocessor_notice: {
    transactional: false,
    compose: ({ listVersion, summary, effectiveOn, listUrl }, ctx) => {
      const subject = ctx.t("subprocessor_notice.subject", { effectiveOn });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("subprocessor_notice.heading", { listVersion })}
            transactional={false}
            action={{ label: ctx.t("subprocessor_notice.review"), url: listUrl }}
          >
            <Paragraph>{ctx.t("subprocessor_notice.intro", { effectiveOn })}</Paragraph>
            <Paragraph>{summary}</Paragraph>
            <Paragraph>{ctx.t("subprocessor_notice.objection")}</Paragraph>
          </Layout>
        ),
      };
    },
  },
};
