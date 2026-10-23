import {
  appealDeadline,
  canAppeal,
  listModerationDecisions,
  listPlatformSupportSessions,
  listSupportAccessLog,
} from "@xos/data/platform-support";
import { InlineAlert } from "@/components/ui";
import { GrantPlatformSupportForm, ModerationAppealForm } from "@/components/platform/a90-forms";
import { EndSupportSessionForm } from "@/components/platform/settings-forms";
import { getFormatters } from "@/lib/platform/format";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A90's settings panels (ADR 0021 item 7):
 *   Settings, Security                 platform support sessions the Owner grants the XOS platform team, and who on
 *                                      the platform team opened what (Section 8)
 *   Settings, Gateway and Marketplace  moderation decisions on the org's listings with their statement of reasons,
 *                                      and the appeal (Digital Services Act articles 17 and 20)
 * Each panel reads with the viewer's client, so row level security and the RPCs decide.
 */

function Heading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-secondary">{description}</p>
    </header>
  );
}

async function PlatformSupportPanel({ ctx }: SettingsPanelProps) {
  const owner = ctx.capabilities.has("org.support_session.grant");
  const auditor = owner || ctx.capabilities.has("audit.log.read");
  if (!auditor) return null;
  const { t, dateTime } = await getFormatters(ctx);
  const [sessions, accesses] = await Promise.all([
    listPlatformSupportSessions(ctx.viewer.db, ctx.org.id),
    listSupportAccessLog(ctx.viewer.db, ctx.org.id),
  ]);
  const open = sessions.ok ? sessions.data.find((s) => s.open) : undefined;
  return (
    <section
      aria-labelledby="platform-support"
      className="flex flex-col gap-12"
      data-testid="platform-support"
    >
      <Heading
        id="platform-support"
        title={t("access.platformSupport.title")}
        description={t("access.platformSupport.description")}
      />
      {!sessions.ok || !accesses.ok ? (
        <InlineAlert tone="danger">{t("access.support.loadError")}</InlineAlert>
      ) : (
        <>
          {open ? (
            <div className="flex flex-col gap-8 rounded-card border border-border-subtle p-12">
              <p className="m-0 text-text-13">
                {t("access.platformSupport.open", {
                  when: dateTime(open.endsAt),
                  reason: open.reason,
                })}
              </p>
              {owner ? <EndSupportSessionForm org={ctx.org.slug} session={open.id} /> : null}
            </div>
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("access.platformSupport.none")}
            </p>
          )}
          {owner && !open ? <GrantPlatformSupportForm org={ctx.org.slug} /> : null}
          {!owner ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("access.support.ownerOnly")}</p>
          ) : null}
          <h3 className="m-0 text-text-14 font-semibold">{t("access.platformSupport.log")}</h3>
          {accesses.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("access.platformSupport.noAccess")}
            </p>
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-4 p-0"
              aria-label={t("access.platformSupport.log")}
            >
              {accesses.data.map((a) => (
                <li key={a.id} className="text-text-12">
                  {t("access.platformSupport.access", {
                    when: dateTime(a.accessedAt),
                    name: a.operatorName ?? t("access.platformSupport.operator"),
                    area: t(`access.platformSupport.areas.${a.area}`),
                  })}
                </li>
              ))}
            </ul>
          )}
          {sessions.data.filter((s) => !s.open).length > 0 ? (
            <ul
              className="m-0 flex list-none flex-col gap-4 p-0"
              aria-label={t("access.support.history")}
            >
              {sessions.data
                .filter((s) => !s.open)
                .map((s) => (
                  <li key={s.id} className="text-text-12 text-text-secondary">
                    {t("access.support.past", {
                      from: dateTime(s.startsAt),
                      to: dateTime(s.endedAt ?? s.endsAt),
                      reason: s.reason,
                    })}
                  </li>
                ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

async function ModerationDecisionsPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("opportunities.marketplace.manage")) return null;
  const { t, dateTime } = await getFormatters(ctx);
  const decisions = await listModerationDecisions(ctx.viewer.db, ctx.org.id);
  return (
    <section
      aria-labelledby="moderation-decisions"
      className="flex flex-col gap-12"
      data-testid="moderation-decisions"
    >
      <Heading
        id="moderation-decisions"
        title={t("moderation.title")}
        description={t("moderation.description")}
      />
      {!decisions.ok ? (
        <InlineAlert tone="danger">{t("moderation.loadError")}</InlineAlert>
      ) : decisions.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("moderation.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {decisions.data.map((d) => (
            <li
              key={d.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <p className="m-0 text-text-14 font-semibold">
                {t("moderation.decision", {
                  title: d.opportunityTitle ?? t("moderation.untitled"),
                  action: t(`moderation.actions.${d.action}`),
                  when: dateTime(d.decidedAt),
                })}
              </p>
              <p className="m-0 text-text-13">{d.statement}</p>
              {d.ruleReference ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("moderation.rule", { rule: d.ruleReference })}
                </p>
              ) : null}
              {d.facts ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("moderation.facts", { facts: d.facts })}
                </p>
              ) : null}
              {d.appeal ? (
                <p className="m-0 text-text-12" data-testid="appeal-state">
                  {d.appeal.state === "Open"
                    ? t("moderation.appealOpen", { when: dateTime(d.appeal.filedAt) })
                    : t("moderation.appealDecided", {
                        state: t(`moderation.appealStates.${d.appeal.state}`),
                        statement: d.appeal.decisionStatement ?? "",
                      })}
                </p>
              ) : canAppeal(d) ? (
                <>
                  <p className="m-0 text-text-12 text-text-secondary">
                    {t("moderation.appealUntil", {
                      until: dateTime(appealDeadline(d.decidedAt).toISOString()),
                    })}
                  </p>
                  <ModerationAppealForm org={ctx.org.slug} decision={d.id} />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.security", order: 45, Panel: PlatformSupportPanel },
  { node: "settings.gateway-and-marketplace", order: 50, Panel: ModerationDecisionsPanel },
];
