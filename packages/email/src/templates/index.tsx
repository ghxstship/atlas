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
   * One-tap actions (A127, ADR 0106): signed, single-use links to the confirm page of each action the item's Inbox
   * entry offers. A link never acts by itself; the confirm page asks, and a rejection asks for the reason.
   */
  readonly actions?: readonly EmailAction[];
}

export interface TemplateProps {
  readonly notification: KindItem;
  /**
   * A notice the billing terms promise (ADR 0161): the purchase confirmation, the renewal reminder, a cancel confirmed or
   * not yet. Rendered as a notification, but transactional, so no setting or unsubscribe link stops it.
   */
  readonly billing_notice: KindItem;
  readonly digest: { readonly frequency: "daily" | "weekly"; readonly items: readonly KindItem[] };
  readonly invite: {
    readonly inviterName: string;
    readonly roleName: string;
    readonly acceptUrl: string;
    readonly expiresAt: Date;
  };
  /**
   * A scheduled report (A35): the file goes as an attachment. The link to the report is there only for a recipient
   * who may open it in Atlas (app.report_delivery, 904090003).
   */
  readonly report_delivery: {
    readonly reportName: string;
    readonly periodLabel: string;
    readonly format: string;
    readonly url?: string;
    /** The run's rows and how many carry an unpriced amount, when the sender knows them. */
    readonly rows?: number;
    readonly unpriced?: number;
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
  /**
   * An invitation to an external account or onto a crew roster (R4, migrations 2630 and 2636), sent by the
   * platform to an address that may not be on XOS yet. The link is Gateway sign-in; the address never goes
   * into it, because the invitation is claimed by the confirmed email the person signs in with.
   */
  readonly party_invitation: {
    readonly kind: "account" | "roster" | "pool";
    readonly inviterName: string;
    readonly accountName: string;
    readonly projectName: string;
    readonly partyName: string;
    /** A pool invitation names the org and the role, never the pool (B10). */
    readonly orgName?: string;
    readonly jobTitle?: string;
    readonly expiresAt: Date;
    readonly signInUrl: string;
  };
  /**
   * The access code of a signed-out approval link (P9, ADR 0138): minted while the email is rendered, never stored in
   * clear, valid for expiresInMinutes. The org name says who asks; the code alone decides nothing without the link.
   */
  readonly approval_link_code: {
    readonly code: string;
    readonly orgName: string;
    readonly expiresInMinutes: number;
  };

  /**
   * An org's email to a guest on its guest list (B8, migration 6255, ADR 0147 decision 7): an invitation, the guest's
   * pass (the guest-pass PDF goes as an attachment) or a message with its own subject and text. Never transactional:
   * it carries the unsubscribe link and the postal address of decision 41.
   */
  /**
   * A stakeholder pack shared with an outside recipient (B2, ADR 0141): a sign-in link, never a file and never the
   * access code. Never transactional: it carries the pack's own stop link and the postal address of decision 41.
   */
  readonly stakeholder_pack: {
    /** Who shared it: the pack's creator, else the org's brand name. */
    readonly senderName: string;
    readonly packName: string;
    readonly message?: string;
    readonly itemTitles: readonly string[];
    readonly url: string;
    /** The link's expiry as the recipient reads it, in the project's zone with the zone's name. */
    readonly expiresText: string;
  };
  readonly guest_message: {
    /** app.guest_email_kind: Invitation, Pass or Message. */
    readonly kind: string;
    readonly guestName: string;
    readonly projectName: string;
    readonly showName?: string;
    readonly showDate?: Date;
    readonly plusOnes: number;
    readonly subject?: string;
    readonly body?: string;
  };
  /**
   * The legal queue's digest (ADR 0167, migration 6862): the clocks an hourly sweep found coming due or overdue. A backup
   * contact sees references and dates and never the matter, because a government request can come with an order forbidding
   * disclosure. Only an operator gets a link, since only an operator can sign in to the console.
   */
  readonly legal_clock_alert: {
    readonly audience: "operator" | "backup" | "reviewer";
    readonly overdue: number;
    readonly dueSoon: number;
    readonly items: readonly {
      readonly reference: string;
      readonly matter?: string;
      readonly clock: "First Response" | "Due";
      readonly at: Date;
      readonly overdue: boolean;
    }[];
    readonly queueUrl?: string;
  };
  /**
   * The outcome of a moderation decision or appeal for someone the notification queue cannot reach, such as a reporter
   * with no tie to the org, or a statement of reasons to a member with every channel off (ADR 0167, migration 6863). The
   * words are the same notice the queue would carry.
   */
  readonly moderation_notice: {
    readonly kind: "listing.moderated" | "listing_report.decided" | "moderation_appeal.decided";
    readonly args: MessageArgs;
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

/** Kinds whose Accept button says what accepting means (B9: "Still coming?" accepts as Confirm you're coming). */
const ACCEPT_LABELS: Readonly<Record<string, string>> = {
  "shift.reconfirm": "notification.actions.confirmComing",
};

/**
 * The one-tap action buttons (A127): each opens the confirm page, so acting from an email takes two taps. Approve and
 * accept are filled; reject is outlined, after them.
 */
function ActionLinks({
  actions,
  kind,
  t,
}: {
  readonly actions: readonly EmailAction[];
  readonly kind: string;
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
            {t(
              a.action === "accept" && ACCEPT_LABELS[kind]
                ? ACCEPT_LABELS[kind]
                : `notification.actions.${a.action}`,
            )}
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

/** The access code, in the heading style so it reads at a glance (P9). */
const codeStyle = {
  ...text("heading-20"),
  color: color("text-primary"),
  margin: `0 0 ${space("space-16")}`,
} as const;

function Greeting({ ctx }: { readonly ctx: TemplateContext }) {
  return <Paragraph>{ctx.t("common.greeting", { name: ctx.recipientName })}</Paragraph>;
}

/** A kind's email. A transactional one (billing_notice) has no unsubscribe link or one-tap actions. */
function composeKind(item: KindItem, ctx: TemplateContext, transactional: boolean) {
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
        transactional={transactional}
        action={{ label: ctx.t("common.open"), url: item.url }}
      >
        <Greeting ctx={ctx} />
        <Paragraph>{ctx.t(kindKey(item.kind, "body"), item.args)}</Paragraph>
        {transactional ? null : (
          <ActionLinks actions={item.actions ?? []} kind={item.kind} t={ctx.t} />
        )}
      </Layout>
    ),
  };
}

export const templates: { readonly [C in TemplateCode]: Template<TemplateProps[C]> } = {
  notification: { transactional: false, compose: (item, ctx) => composeKind(item, ctx, false) },
  billing_notice: { transactional: true, compose: (item, ctx) => composeKind(item, ctx, true) },
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
    compose: ({ reportName, periodLabel, format, url, rows, unpriced }, ctx) => {
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
            {...(url === undefined ? {} : { action: { label: ctx.t("common.open"), url } })}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("report_delivery.body", { periodLabel, format })}</Paragraph>
            {rows !== undefined && (
              <Paragraph>
                {ctx.t("report_delivery.contents", { rows, unpriced: unpriced ?? 0 })}
              </Paragraph>
            )}
            <Paragraph>{ctx.t("report_delivery.access")}</Paragraph>
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
  party_invitation: {
    transactional: true,
    compose: (p, ctx) => {
      const subject =
        p.kind === "account"
          ? ctx.t("party_invitation.accountSubject", {
              inviterName: p.inviterName,
              accountName: p.accountName,
            })
          : p.kind === "pool"
            ? ctx.t("party_invitation.poolSubject", {
                inviterName: p.inviterName,
                orgName: p.orgName ?? "",
              })
            : ctx.t("party_invitation.rosterSubject", {
                inviterName: p.inviterName,
                partyName: p.partyName,
                projectName: p.projectName,
              });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={subject}
            transactional
            action={{ label: ctx.t("party_invitation.action"), url: p.signInUrl }}
          >
            {p.kind === "pool" && p.jobTitle ? (
              <Paragraph>{ctx.t("party_invitation.poolRole", { jobTitle: p.jobTitle })}</Paragraph>
            ) : null}
            <Paragraph>
              {ctx.t(p.kind === "pool" ? "party_invitation.poolHow" : "party_invitation.how", {
                expiresAt: p.expiresAt,
              })}
            </Paragraph>
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
  legal_clock_alert: {
    transactional: true,
    compose: ({ audience, overdue, dueSoon, items, queueUrl }, ctx) => {
      if (items.length === 0) throw new Error("A legal clock alert needs at least one item");
      const subject = ctx.t("legal_clock_alert.subject", { overdue, dueSoon });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={subject}
            transactional
            {...(audience === "operator" && queueUrl
              ? { action: { label: ctx.t("legal_clock_alert.open"), url: queueUrl } }
              : {})}
          >
            <Paragraph>{ctx.t(`legal_clock_alert.intro.${audience}`)}</Paragraph>
            {items.map((item) => (
              <Paragraph key={`${item.reference} ${item.clock}`}>
                {ctx.t(item.matter ? "legal_clock_alert.itemMatter" : "legal_clock_alert.item", {
                  reference: item.reference,
                  ...(item.matter
                    ? { matter: ctx.t(`legal_clock_alert.matters.${item.matter}`) }
                    : {}),
                  clock: item.clock,
                  overdue: item.overdue ? "yes" : "no",
                  at: item.at,
                })}
              </Paragraph>
            ))}
          </Layout>
        ),
      };
    },
  },
  moderation_notice: {
    transactional: true,
    compose: ({ kind, args }, ctx) => {
      const subject = ctx.t(kindKey(kind, "subject"), args);
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={subject}
            transactional
          >
            <Paragraph>{ctx.t(kindKey(kind, "body"), args)}</Paragraph>
          </Layout>
        ),
      };
    },
  },
  approval_link_code: {
    transactional: true,
    compose: ({ code, orgName, expiresInMinutes }, ctx) => {
      const subject = ctx.t("approval_link_code.subject", { orgName });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={ctx.t("approval_link_code.heading")}
            transactional
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("approval_link_code.body", { orgName })}</Paragraph>
            <Text style={codeStyle}>{code}</Text>
            <Paragraph>
              {ctx.t("approval_link_code.expiry", { minutes: expiresInMinutes })}
            </Paragraph>
            <Paragraph>{ctx.t("approval_link_code.ignore")}</Paragraph>
          </Layout>
        ),
      };
    },
  },
  stakeholder_pack: {
    transactional: false,
    compose: (p, ctx) => {
      const words = { sender: p.senderName, pack: p.packName };
      const subject = ctx.t("stakeholder_pack.subject", words);
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={p.packName}
            transactional={false}
            action={{ label: ctx.t("stakeholder_pack.open"), url: p.url }}
            why={ctx.t("stakeholder_pack.why", {
              sender: p.senderName,
              orgName: ctx.sender.orgName,
            })}
            preferencesLabel={ctx.t("stakeholder_pack.preferences")}
          >
            <Greeting ctx={ctx} />
            <Paragraph>{ctx.t("stakeholder_pack.intro", words)}</Paragraph>
            {p.message !== undefined && (
              <Paragraph>{ctx.t("stakeholder_pack.message", { message: p.message })}</Paragraph>
            )}
            {p.itemTitles.length > 0 && (
              <Paragraph>
                {ctx.t("stakeholder_pack.items", { items: p.itemTitles.join(", ") })}
              </Paragraph>
            )}
            <Paragraph>{ctx.t("stakeholder_pack.expires", { date: p.expiresText })}</Paragraph>
            <Paragraph>{ctx.t("stakeholder_pack.code")}</Paragraph>
          </Layout>
        ),
      };
    },
  },
  guest_message: {
    transactional: false,
    compose: (p, ctx) => {
      const orgName = ctx.sender.orgName;
      const subject =
        p.kind === "Message" && p.subject !== undefined
          ? p.subject
          : ctx.t(
              p.kind === "Pass" ? "guest_message.passSubject" : "guest_message.invitationSubject",
              {
                orgName,
                projectName: p.projectName,
              },
            );
      const show =
        p.showName === undefined
          ? null
          : p.showDate === undefined
            ? ctx.t("guest_message.show", { showName: p.showName })
            : ctx.t("guest_message.showOn", { showName: p.showName, showDate: p.showDate });
      return {
        subject,
        element: (
          <Layout
            locale={ctx.locale}
            t={ctx.t}
            sender={ctx.sender}
            preview={subject}
            heading={
              p.kind === "Message"
                ? subject
                : ctx.t("guest_message.heading", { projectName: p.projectName })
            }
            transactional={false}
            why={ctx.t("guest_message.why", { orgName })}
            preferencesLabel={ctx.t("guest_message.preferences")}
          >
            <Paragraph>{ctx.t("guest_message.greeting", { name: p.guestName })}</Paragraph>
            {p.kind === "Invitation" && (
              <Paragraph>
                {ctx.t("guest_message.invitation", { orgName, projectName: p.projectName })}
              </Paragraph>
            )}
            {p.kind === "Pass" && (
              <Paragraph>
                {ctx.t("guest_message.pass", { projectName: p.projectName, plusOnes: p.plusOnes })}
              </Paragraph>
            )}
            {show !== null && <Paragraph>{show}</Paragraph>}
            {p.body !== undefined && <Paragraph>{p.body}</Paragraph>}
          </Layout>
        ),
      };
    },
  },
};
