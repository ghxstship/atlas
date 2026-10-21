import {
  getProjectInbox,
  inboxAddress,
  listFilingTargets,
  listProjectInbox,
  type InboxItem,
} from "@xos/data/project-inbox";
import type { Route } from "next";
import NextLink from "next/link";
import { getFormatter } from "next-intl/server";
import {
  createProjectInboxAction,
  disableProjectInboxAction,
  discardInboxMessageAction,
  fileInboxMessageAction,
  replaceProjectInboxAction,
} from "@/app/[org]/p/[projectKey]/documents/inbox-actions";
import { ActionButton } from "@/components/collection-kit/kit";
import { InlineAlert } from "@/components/ui";
import { env } from "@/lib/env";
import type { ProjectContext } from "@/lib/projects/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { CopyValue } from "./inbox-client";

/**
 * The project inbox (Section 4.6.5, finding A65-018, migration 1411). Project Settings shows the
 * address and creates, replaces or turns it off; the Documents tab lists the mail that arrived,
 * with File (a Document record of the project, optionally on one of its records) and Discard
 * (with a reason). Row level security shows the mail only to people who file documents on the
 * project, and the 1411 guard decides every filing and discard.
 */

const P = "platform.projectInbox";
const REFUSALS = "platform.refusals";

function Address({ t, localPart }: { t: Translate; localPart: string }) {
  const full = inboxAddress(localPart, env().XOS_INBOUND_DOMAIN);
  return full ? (
    <CopyValue
      id="project-inbox-address"
      label={t(`${P}.address`)}
      value={full}
      copyLabel={t(`${P}.copy`)}
      copiedLabel={t(`${P}.copied`)}
    />
  ) : (
    <p className="m-0 text-text-13 text-text-secondary">
      {t(`${P}.addressPending`, { local: localPart })}
    </p>
  );
}

function Header({ t, id }: { t: Translate; id: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {t(`${P}.title`)}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.description`)}</p>
    </header>
  );
}

/** Project Settings: the inbox address, created, replaced or turned off by settings writers. */
export async function ProjectInboxSettings({ ctx }: { ctx: ProjectContext }) {
  const t = await getTranslate();
  const inbox = await getProjectInbox(ctx.org.viewer.db, ctx.project.id);
  if (!inbox.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const canManage = ctx.capabilities.has("projects.settings.write");
  const hidden = {
    org: ctx.org.org.slug,
    projectId: ctx.project.id,
    projectKey: ctx.project.key,
  };
  return (
    <section
      aria-labelledby="project-inbox-settings"
      className="flex max-w-layout-form flex-col gap-12"
    >
      <Header t={t} id="project-inbox-settings" />
      {inbox.data ? (
        <Address t={t} localPart={inbox.data.localPart} />
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">
          {t(canManage ? `${P}.noAddress` : `${P}.noAddressReader`)}
        </p>
      )}
      {canManage ? (
        <div className="flex flex-wrap gap-8">
          {inbox.data ? (
            <>
              <ActionButton
                action={replaceProjectInboxAction}
                hidden={hidden}
                label={t(`${P}.replace`)}
                confirm={{ title: t(`${P}.replaceTitle`), body: t(`${P}.replaceBody`) }}
                refusals={REFUSALS}
              />
              <ActionButton
                action={disableProjectInboxAction}
                hidden={hidden}
                label={t(`${P}.disable`)}
                variant="danger"
                confirm={{ title: t(`${P}.disableTitle`), body: t(`${P}.disableBody`) }}
                refusals={REFUSALS}
              />
            </>
          ) : (
            <ActionButton
              action={createProjectInboxAction}
              hidden={hidden}
              label={t(`${P}.create`)}
              refusals={REFUSALS}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function stateTone(state: InboxItem["state"]): string {
  if (state === "open") return "text-accent-text";
  if (state === "rejected") return "text-warning-text";
  if (state === "filed") return "text-success-text";
  return "text-text-secondary";
}

/** The Documents tab: mail in the project inbox, to file or discard. */
export async function ProjectInboxSection({
  ctx,
  showAll,
  path,
}: {
  ctx: ProjectContext;
  showAll: boolean;
  path: string;
}) {
  if (!ctx.capabilities.has("knowledge.document.write")) return null;
  const db = ctx.org.viewer.db;
  const [t, format, inbox, items, targets] = await Promise.all([
    getTranslate(),
    getFormatter(),
    getProjectInbox(db, ctx.project.id),
    listProjectInbox(db, ctx.project.id),
    listFilingTargets(db, ctx.project.id, ctx.project.key),
  ]);
  if (!inbox.ok || !items.ok || !targets.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const pending = items.data.filter((i) => i.state === "open" || i.state === "rejected");
  const shown = showAll ? items.data : pending;
  const toFile = items.data.filter((i) => i.state === "open").length;
  const hidden = (item: InboxItem) => ({
    org: ctx.org.org.slug,
    id: item.id,
    projectKey: ctx.project.key,
  });
  const recordOptions = [
    { value: "", label: t(`${P}.noRecord`) },
    ...targets.data.map((r) => ({ value: r.id, label: r.label })),
  ];
  return (
    <section aria-labelledby="project-inbox" className="flex flex-col gap-12">
      <Header t={t} id="project-inbox" />
      {inbox.data ? <Address t={t} localPart={inbox.data.localPart} /> : null}
      <p className="m-0 text-text-13 font-medium">
        {toFile > 0 ? t(`${P}.toFile`, { count: toFile }) : t(`${P}.nothingToFile`)}
      </p>
      {shown.length > 0 ? (
        <ul
          aria-label={t(`${P}.listLabel`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {shown.map((item) => (
            <li key={item.id} className="flex flex-col gap-8 p-12" data-testid="inbox-item">
              <div className="flex flex-wrap items-start justify-between gap-12">
                <div className="flex min-w-0 flex-col gap-4">
                  <span className="text-label-13 font-medium">
                    {item.subject?.trim() || t(`${P}.noSubject`)}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {[
                      t(`${P}.from`, { from: item.fromAddress }),
                      t(`${P}.received`, { date: when(item.receivedAt) }),
                    ].join(" · ")}
                  </span>
                </div>
                <span
                  className={`inline-flex rounded-chip border border-border-subtle px-8 py-2 text-text-12 font-medium ${stateTone(item.state)}`}
                >
                  {t(`${P}.state.${item.state}`)}
                </span>
              </div>
              {item.body ? (
                <p className="m-0 whitespace-pre-line text-text-13 text-text-secondary">
                  {item.body.length > 600 ? `${item.body.slice(0, 600)}…` : item.body}
                </p>
              ) : null}
              {item.state === "rejected" ? (
                <p className="m-0 text-text-12 text-warning-text">{t(`${P}.rejectedHelp`)}</p>
              ) : null}
              {item.state === "filed" ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t(`${P}.filedAs`, {
                    document: item.documentTitle ?? "",
                    name: item.filedByName ?? t(`${P}.someone`),
                    date: item.filedAt ? when(item.filedAt) : "",
                  })}
                  {item.recordTitle ? ` · ${t(`${P}.filedTo`, { record: item.recordTitle })}` : ""}
                </p>
              ) : null}
              {item.state === "discarded" ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t(`${P}.discardedBy`, {
                    name: item.discardedByName ?? t(`${P}.someone`),
                    date: item.discardedAt ? when(item.discardedAt) : "",
                  })}
                  {item.discardReason
                    ? ` · ${t(`${P}.discardedReason`, { reason: item.discardReason })}`
                    : ""}
                </p>
              ) : null}
              {item.state === "open" || item.state === "rejected" ? (
                <div className="flex flex-wrap gap-8">
                  {item.state === "open" ? (
                    <ActionButton
                      action={fileInboxMessageAction}
                      hidden={hidden(item)}
                      label={t(`${P}.file`)}
                      confirm={{ title: t(`${P}.fileTitle`), body: t(`${P}.fileBody`) }}
                      extraFields={[
                        {
                          kind: "text",
                          name: "title",
                          label: t(`${P}.documentTitle`),
                          defaultValue: (item.subject?.trim() || item.fromAddress).slice(0, 200),
                        },
                        {
                          kind: "select",
                          name: "recordId",
                          label: t(`${P}.record`),
                          options: recordOptions,
                          defaultValue: "",
                        },
                      ]}
                      refusals={REFUSALS}
                    />
                  ) : null}
                  <ActionButton
                    action={discardInboxMessageAction}
                    hidden={hidden(item)}
                    label={t(`${P}.discard`)}
                    variant="ghost"
                    reason={t(`${P}.discardTitle`)}
                    refusals={REFUSALS}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {items.data.length > pending.length || showAll ? (
        <NextLink
          href={(showAll ? path : `${path}?inbox=all`) as Route}
          className="text-text-13 text-accent-text underline"
        >
          {showAll ? t(`${P}.showOpen`) : t(`${P}.showAll`)}
        </NextLink>
      ) : null}
    </section>
  );
}
