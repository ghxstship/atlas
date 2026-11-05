"use client";

import type { AvailabilityAnswer, AvailabilityRequest } from "@xos/data/crew";
import { Button, Card, InlineAlert, Select } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { answerAvailabilityPollAction } from "@/app/[org]/crew/scheduling-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const KINDS: readonly AvailabilityAnswer[] = ["Available", "Tentative", "Unavailable"];

/**
 * The Requests card of Me, Work details (P8): each open availability poll addressed to the member,
 * with an Available, Tentative or Unavailable choice per day. A day the org's notice lock already
 * holds reads as locked and cannot be changed here. Answering shares those days with the org's
 * planners, as the card says.
 */
export function AvailabilityRequests({
  org,
  requests,
}: {
  org: string;
  requests: readonly AvailabilityRequest[];
}) {
  const t = useTranslations("crew.scheduling.polls.requests") as unknown as Translate;
  if (requests.length === 0) return null;
  return (
    <section
      id="availability-requests"
      aria-labelledby="availability-requests-title"
      className="flex flex-col gap-8"
    >
      <h3 id="availability-requests-title" className="m-0 text-label-13 font-semibold">
        {t("title", { count: requests.length })}
      </h3>
      <p className="m-0 text-text-12 text-text-secondary">{t("shared")}</p>
      {requests.map((r) => (
        <RequestCard key={r.pollId} org={org} request={r} t={t} />
      ))}
    </section>
  );
}

function RequestCard({
  org,
  request,
  t,
}: {
  org: string;
  request: AvailabilityRequest;
  t: Translate;
}) {
  const format = useFormatter();
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, AvailabilityAnswer | "">>(() =>
    Object.fromEntries(request.days.map((d) => [d.day, d.answer ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [pending, start] = useTransition();
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  const chosen = request.days.filter((d) => !d.locked && answers[d.day]);

  const save = () =>
    start(async () => {
      const result = await answerAvailabilityPollAction(org, {
        pollId: request.pollId,
        answers: chosen.map((d) => ({ day: d.day, kind: answers[d.day] as AvailabilityAnswer })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      const locked = result.answers.filter((a) => !a.written).length;
      setSaid(
        locked > 0
          ? t("savedSomeLocked", { count: result.answers.length - locked, locked })
          : t("saved", { count: result.answers.length }),
      );
      router.refresh();
    });

  return (
    <Card title={request.title} meta={request.projectName}>
      <div className="flex flex-col gap-8">
        {request.message ? <p className="m-0 text-text-13">{request.message}</p> : null}
        {request.closesAt ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t("closes", {
              when: format.dateTime(new Date(request.closesAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-6 p-0">
          {request.days.map((d) => (
            <li key={d.day} className="flex flex-wrap items-end gap-8">
              {d.locked ? (
                <p className="m-0 text-text-13">
                  {t("locked", {
                    day: day(d.day),
                    answer: d.answer ? t(`kinds.${d.answer}`) : t("kinds.Unstated"),
                  })}
                </p>
              ) : (
                <Select
                  id={`poll-${request.pollId}-${d.day}`}
                  label={day(d.day)}
                  value={answers[d.day] ?? ""}
                  options={[
                    { value: "", label: t("choose") },
                    ...KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) })),
                  ]}
                  onChange={(e) =>
                    setAnswers({ ...answers, [d.day]: e.target.value as AvailabilityAnswer | "" })
                  }
                />
              )}
            </li>
          ))}
        </ul>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <div>
          <Button variant="primary" loading={pending} disabled={chosen.length === 0} onClick={save}>
            {t("save")}
          </Button>
        </div>
        <p aria-live="polite" className="sr-only">
          {said}
        </p>
      </div>
    </Card>
  );
}
