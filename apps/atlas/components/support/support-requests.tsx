"use client";

import type { SupportTicket, SupportTicketDetail, SupportTicketState } from "@xos/data/support";
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  InlineAlert,
  Input,
  Select,
  Skeleton,
  Textarea,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import {
  loadTicketAction,
  moveTicketAction,
  replyTicketAction,
  type SupportError,
} from "@/lib/support/actions";
import { openHelpArticle } from "@/components/help/help-center";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Filter = "open" | "Organization" | "Platform" | "all";

/**
 * Support requests as a table with the request open in a drawer (`?ticket=<id>`), used on Settings,
 * Help and support (every request of the org, for those who answer support) and on Me, Account (the
 * person's own requests). The drawer shows the diagnostics sent with consent, the conversation, a
 * reply box and the state changes the person may make; the database decides each one.
 */
export function SupportRequests({
  org,
  tickets,
  viewerMembershipId,
  canAnswer,
  showRequester,
  showFilter,
  emptyText,
}: {
  org: string;
  tickets: readonly SupportTicket[];
  viewerMembershipId: string | null;
  canAnswer: boolean;
  showRequester: boolean;
  showFilter: boolean;
  emptyText: string;
}) {
  const t = useTranslations("support") as unknown as Translate;
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const id = useId();
  const [filter, setFilter] = useState<Filter>("open");
  const open = search.get("ticket");

  const setTicket = (ticket: string | null) => {
    const next = new URLSearchParams(search.toString());
    if (ticket) next.set("ticket", ticket);
    else next.delete("ticket");
    const q = next.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route, { scroll: false });
  };

  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "";
  const shown = tickets.filter((x) =>
    !showFilter || filter === "all"
      ? true
      : filter === "open"
        ? x.state === "Open" || x.state === "Waiting"
        : x.queue === filter,
  );

  return (
    <div className="flex flex-col gap-12">
      {showFilter && tickets.length > 0 ? (
        <Select
          id={`${id}-filter`}
          label={t("org.filter")}
          value={filter}
          options={(["open", "Organization", "Platform", "all"] as const).map((f) => ({
            value: f,
            label: t(`org.filters.${f}`),
          }))}
          onChange={(e) => setFilter(e.target.value as Filter)}
        />
      ) : null}
      {tickets.length === 0 ? (
        <EmptyState
          icon="LifeBuoy"
          sentence={emptyText}
          actionLabel={t("openHelp")}
          onAction={() => openHelpArticle("contact-support")}
        />
      ) : shown.length === 0 ? (
        <p className="m-0 text-text-secondary">{t("org.emptyFiltered")}</p>
      ) : (
        <DataTable
          caption={t("org.title")}
          height="auto"
          columns={[
            { key: "number", label: t("columns.number"), type: "code" },
            { key: "subject", label: t("columns.subject"), wrap: true },
            ...(showRequester ? [{ key: "requester", label: t("columns.requester") }] : []),
            { key: "queue", label: t("columns.queue") },
            { key: "state", label: t("columns.state") },
            { key: "opened", label: t("columns.opened") },
            { key: "due", label: t("columns.due") },
          ]}
          rows={shown.map((x) => ({
            id: x.id,
            number: x.number,
            subject: x.subject,
            requester: x.requesterName ?? t("unknownPerson"),
            queue: t(`queues.${x.queue}`),
            state: t(`states.${x.state}`),
            opened: when(x.createdAt),
            due:
              x.queue === "Platform"
                ? x.firstResponseDueAt
                  ? when(x.firstResponseDueAt)
                  : t("bestEffort")
                : "",
          }))}
          onRowActivate={(row) => setTicket(String(row["id"]))}
        />
      )}
      {open ? (
        <TicketDrawer
          key={open}
          org={org}
          ticketId={open}
          viewerMembershipId={viewerMembershipId}
          canAnswer={canAnswer}
          onClose={() => setTicket(null)}
        />
      ) : null}
    </div>
  );
}

function TicketDrawer({
  org,
  ticketId,
  viewerMembershipId,
  canAnswer,
  onClose,
}: {
  org: string;
  ticketId: string;
  viewerMembershipId: string | null;
  canAnswer: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("support") as unknown as Translate;
  const format = useFormatter();
  const id = useId();
  const [ticket, setTicket] = useState<SupportTicketDetail | null>(null);
  const [loadError, setLoadError] = useState<SupportError | null>(null);
  const [reply, setReply] = useState("");
  const [next, setNext] = useState<SupportTicketState | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SupportError | null>(null);
  const [status, setStatus] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    loadTicketAction(org, ticketId).then(
      (result) => {
        if (!live) return;
        if (result.ok) setTicket(result.data);
        else setLoadError(result.error);
      },
      () => {
        if (live) setLoadError("unexpected");
      },
    );
    return () => {
      live = false;
    };
  }, [org, ticketId, version]);

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const requester = ticket !== null && ticket.requesterMembershipId === viewerMembershipId;
  const responder = canAnswer && ticket?.queue === "Organization";
  const moves = (ticket?.nextStates ?? []).filter(
    (s) =>
      responder || (requester && (s === "Closed" || (s === "Open" && ticket?.state !== "Open"))),
  );

  const run = async (
    action: () => Promise<{ ok: boolean; error?: SupportError }>,
    done: string,
  ) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "unexpected");
      return;
    }
    setStatus(done);
    setReply("");
    setReason("");
    setNext("");
    setVersion((v) => v + 1);
  };

  return (
    <Drawer
      title={
        ticket
          ? t("ticket.title", { number: ticket.number, subject: ticket.subject })
          : t("ticket.loading")
      }
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <p role="status" className="sr-only">
        {status}
      </p>
      {loadError ? (
        <InlineAlert tone="danger">
          {t(loadError === "notFound" ? "ticket.notFound" : "ticket.loadFailed")}
        </InlineAlert>
      ) : ticket === null ? (
        <div aria-label={t("ticket.loading")} className="flex flex-col gap-8">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : (
        <>
          <section aria-labelledby={`${id}-details`} className="flex flex-col gap-8">
            <h3 id={`${id}-details`} className="m-0 text-text-12 font-medium text-text-secondary">
              {t("ticket.details")}
            </h3>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-12 gap-y-4 text-text-13">
              <dt className="text-text-secondary">{t("columns.state")}</dt>
              <dd className="m-0">{t(`states.${ticket.state}`)}</dd>
              <dt className="text-text-secondary">{t("columns.queue")}</dt>
              <dd className="m-0">{t(`queues.${ticket.queue}`)}</dd>
              <dt className="text-text-secondary">{t("columns.requester")}</dt>
              <dd className="m-0">{ticket.requesterName ?? t("unknownPerson")}</dd>
              <dt className="text-text-secondary">{t("columns.opened")}</dt>
              <dd className="m-0">{when(ticket.createdAt)}</dd>
              {ticket.queue === "Platform" ? (
                <>
                  <dt className="text-text-secondary">{t("columns.due")}</dt>
                  <dd className="m-0">
                    {ticket.firstResponseDueAt ? when(ticket.firstResponseDueAt) : t("bestEffort")}
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="m-0 whitespace-pre-wrap text-text-primary">{ticket.body}</p>
          </section>
          <section aria-labelledby={`${id}-diag`} className="flex flex-col gap-8">
            <h3 id={`${id}-diag`} className="m-0 text-text-12 font-medium text-text-secondary">
              {t("ticket.diagnostics")}
            </h3>
            {ticket.diagnostics ? (
              <>
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("ticket.consented", { date: when(ticket.diagnostics.consentedAt) })}
                </p>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-12 gap-y-4 text-text-12">
                  {(
                    [
                      ["route", ticket.diagnostics.route],
                      ["appVersion", ticket.diagnostics.appVersion],
                      ["device", ticket.diagnostics.device],
                      ["recentErrors", ticket.diagnostics.recentErrors],
                    ] as const
                  )
                    .filter(([, v]) => v !== null)
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-text-secondary">{t(`ticket.fields.${k}`)}</dt>
                        <dd className="m-0 whitespace-pre-wrap break-all font-mono">{v}</dd>
                      </div>
                    ))}
                </dl>
              </>
            ) : (
              <p className="m-0 text-text-secondary">{t("ticket.noDiagnostics")}</p>
            )}
          </section>
          <section aria-labelledby={`${id}-conv`} className="flex flex-col gap-8">
            <h3 id={`${id}-conv`} className="m-0 text-text-12 font-medium text-text-secondary">
              {t("ticket.conversation")}
            </h3>
            {ticket.messages.length === 0 ? (
              <p className="m-0 text-text-secondary">{t("ticket.noMessages")}</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-8 p-0">
                {ticket.messages.map((m) => (
                  <li key={m.id} className="rounded-card border border-border-subtle p-12">
                    <p className="m-0 text-text-12 text-text-secondary">
                      {(m.authorMembershipId === null
                        ? t("platformTeam")
                        : (m.authorName ?? t("unknownPerson"))) +
                        " · " +
                        when(m.createdAt)}
                    </p>
                    <p className="m-0 whitespace-pre-wrap">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {ticket.state === "Closed" ? (
            <InlineAlert tone="info">{t("ticket.closedNote")}</InlineAlert>
          ) : (
            <form
              className="flex flex-col gap-8"
              onSubmit={(e) => {
                e.preventDefault();
                if (reply.trim() === "") {
                  setError("invalid");
                  return;
                }
                void run(() => replyTicketAction(org, ticket.id, reply), t("ticket.replied"));
              }}
            >
              <Textarea
                label={t("ticket.reply")}
                placeholder={t("ticket.replyHint")}
                value={reply}
                rows={3}
                maxLength={10000}
                width="100%"
                onChange={(e) => setReply(e.target.value)}
              />
              <Button type="submit" variant="primary" loading={busy} className="self-end">
                {t("ticket.send")}
              </Button>
            </form>
          )}
          {moves.length > 0 ? (
            <form
              aria-label={t("ticket.move")}
              className="flex flex-col gap-8"
              onSubmit={(e) => {
                e.preventDefault();
                if (next === "" || reason.trim() === "") {
                  setError("invalid");
                  return;
                }
                void run(
                  () =>
                    moveTicketAction(org, {
                      ticketId: ticket.id,
                      expected: ticket.state,
                      next,
                      reason,
                    }),
                  t("ticket.moved", { state: t(`states.${next}`) }),
                );
              }}
            >
              <Select
                id={`${id}-next`}
                label={t("ticket.move")}
                value={next}
                options={[
                  { value: "", label: t("ticket.move") },
                  ...moves.map((s) => ({
                    value: s,
                    label: t("ticket.moveTo", { state: t(`states.${s}`) }),
                  })),
                ]}
                onChange={(e) => setNext(e.target.value as SupportTicketState | "")}
              />
              <Input
                label={t("ticket.reason")}
                placeholder={t("ticket.reasonHint")}
                value={reason}
                maxLength={500}
                width="100%"
                onChange={(e) => setReason(e.target.value)}
              />
              <Button type="submit" loading={busy} className="self-end">
                {t("ticket.move")}
              </Button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="m-0 text-text-12 text-danger-text">
              {t(`errors.${error}`)}
            </p>
          ) : null}
        </>
      )}
    </Drawer>
  );
}
