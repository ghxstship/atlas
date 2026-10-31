"use client";

import type { PollablePerson } from "@xos/data/crew";
import { Button, Checkbox, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { sendAvailabilityPollAction } from "@/app/[org]/crew/scheduling-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** YYYY-MM-DD days from `first` to `last`, at most 31. */
function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
  for (let at = start; at <= end && out.length < 32; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Ask for availability (P8, ADR 0063): a planner names a project, a title, the days (a run of 1 to
 * 31 days), the people to ask (members and engaged freelancers, with search), an optional message
 * and the day the poll closes. app.send_availability_poll checks every rule and notifies each
 * recipient. Loaded on demand through lazy-scheduling.tsx, so Crew > Shifts carries none of it.
 */
export function AvailabilityPollDialog({
  org,
  projects,
  people,
  today,
  onClose,
}: {
  org: string;
  projects: readonly { readonly id: string; readonly label: string }[];
  people: readonly PollablePerson[];
  /** Today on the org's calendar, YYYY-MM-DD. */
  today: string;
  onClose: () => void;
}) {
  const t = useTranslations("crew.scheduling.polls") as unknown as Translate;
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [first, setFirst] = useState(today);
  const [last, setLast] = useState(today);
  const [message, setMessage] = useState("");
  const [closesOn, setClosesOn] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const days = daysFrom(first, last);
  const tooMany = days.length > 31;
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? people.filter((p) => (p.name ?? "").toLocaleLowerCase().includes(q)) : people;
  }, [people, query]);
  const ready =
    projectId !== "" && title.trim() !== "" && days.length > 0 && !tooMany && picked.size > 0;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  const send = () =>
    start(async () => {
      const result = await sendAvailabilityPollAction(org, {
        projectId,
        title,
        days,
        personIds: [...picked],
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(closesOn ? { closesOn } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t("title")}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" loading={pending} disabled={!ready} onClick={send}>
            {t("send", { count: picked.size })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12 text-text-primary">
        <Select
          id="poll-project"
          label={t("project")}
          value={projectId}
          options={projects.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <Input
          id="poll-title"
          label={t("pollTitle")}
          maxLength={200}
          width="100%"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-wrap gap-12">
          <Input
            id="poll-first"
            type="date"
            label={t("first")}
            min={today}
            width={180}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          />
          <Input
            id="poll-last"
            type="date"
            label={t("last")}
            min={first}
            width={180}
            value={last}
            {...(tooMany ? { error: t("tooManyDays") } : {})}
            onChange={(e) => setLast(e.target.value)}
          />
        </div>
        <p className="m-0 text-text-12 text-text-secondary">
          {t("dayCount", { count: Math.min(days.length, 31) })}
        </p>
        <fieldset className="m-0 flex flex-col gap-6 border-0 p-0">
          <legend className="mb-4 text-label-13 font-semibold">
            {t("recipients", { count: picked.size })}
          </legend>
          <Input
            id="poll-search"
            type="search"
            label={t("search")}
            width="100%"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("noPeople")}</p>
            ) : (
              shown.map((p) => (
                <Checkbox
                  key={p.personId}
                  label={
                    p.engaged
                      ? t("engagedPerson", { name: p.name ?? t("unnamed") })
                      : (p.name ?? t("unnamed"))
                  }
                  checked={picked.has(p.personId)}
                  onChange={(e) => toggle(p.personId, e.currentTarget.checked)}
                />
              ))
            )}
          </div>
        </fieldset>
        <Textarea
          id="poll-message"
          label={t("message")}
          maxLength={1000}
          rows={2}
          width="100%"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <Input
          id="poll-closes"
          type="date"
          label={t("closesOn")}
          help={t("closesOnHelp")}
          min={today}
          width={180}
          value={closesOn}
          onChange={(e) => setClosesOn(e.target.value)}
        />
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      </div>
    </Dialog>
  );
}
