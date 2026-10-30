"use client";

import type { PollablePerson, PollAvailability, PollResultCell } from "@xos/data/crew";
import { Button, Card, Icon } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { AvailabilityPollDialog } from "./availability-poll-dialog";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Each answer has a text label and an icon, never color alone. */
const MARK: Record<PollAvailability, { icon: string; tone: string }> = {
  Available: { icon: "Check", tone: "text-success-text" },
  Tentative: { icon: "CircleHelp", tone: "text-warning-text" },
  Unavailable: { icon: "X", tone: "text-danger-text" },
  Unstated: { icon: "Circle", tone: "text-text-tertiary" },
};

export interface PollWithResults {
  readonly id: string;
  readonly title: string;
  readonly projectLabel: string;
  readonly closesAt: string | null;
  readonly open: boolean;
  readonly days: readonly string[];
  readonly results: readonly PollResultCell[];
}

/**
 * The availability polls of the planner's projects (P8, ADR 0063), each a read-only person-by-day
 * grid of Available, Tentative, Unavailable or Unstated, with when each person last answered. Notes
 * never appear. The New poll button opens the ask dialog. Loaded on demand through
 * lazy-scheduling.tsx, so Crew > Shifts carries none of it.
 */
export function AvailabilityPollResults({
  org,
  polls,
  projects,
  people,
  today,
}: {
  org: string;
  polls: readonly PollWithResults[];
  projects: readonly { readonly id: string; readonly label: string }[];
  people: readonly PollablePerson[];
  today: string;
}) {
  const t = useTranslations("crew.scheduling.polls") as unknown as Translate;
  const format = useFormatter();
  const [asking, setAsking] = useState(false);
  const dayName = (day: string) =>
    format.dateTime(new Date(`${day}T12:00:00Z`), {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

  return (
    <section aria-labelledby="availability-polls" className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id="availability-polls" className="m-0 text-heading-16 font-semibold">
          {t("listTitle")}
        </h2>
        {projects.length > 0 ? (
          <Button variant="primary" size="sm" onClick={() => setAsking(true)}>
            {t("open")}
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-text-13 text-text-secondary">{t("listHelp")}</p>
      {polls.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("none")}</p>
      ) : (
        polls.map((poll) => {
          const people = [...new Map(poll.results.map((r) => [r.personId, r])).values()];
          return (
            <Card key={poll.id} title={poll.title} meta={poll.projectLabel}>
              <p className="m-0 mb-8 text-text-12 text-text-secondary">
                {poll.open
                  ? poll.closesAt
                    ? t("closes", {
                        when: format.dateTime(new Date(poll.closesAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })
                    : t("openNoClose")
                  : t("closed")}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-text-13">
                  <caption className="sr-only">{t("gridCaption", { title: poll.title })}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="p-4 text-start font-medium">
                        {t("person")}
                      </th>
                      {poll.days.map((d) => (
                        <th key={d} scope="col" className="p-4 text-start font-medium">
                          {dayName(d)}
                        </th>
                      ))}
                      <th scope="col" className="p-4 text-start font-medium">
                        {t("responded")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((person) => (
                      <tr key={person.personId} className="border-t border-border-subtle">
                        <th scope="row" className="p-4 text-start font-normal">
                          {person.name ?? t("unnamed")}
                        </th>
                        {poll.days.map((d) => {
                          const cell = poll.results.find(
                            (r) => r.personId === person.personId && r.day === d,
                          );
                          const kind = cell?.availability ?? "Unstated";
                          return (
                            <td key={d} className="p-4">
                              <span className={`inline-flex items-center gap-4 ${MARK[kind].tone}`}>
                                <Icon name={MARK[kind].icon} size={14} />
                                <span>{t(`kinds.${kind}`)}</span>
                              </span>
                            </td>
                          );
                        })}
                        <td className="p-4 text-text-secondary">
                          {person.respondedAt
                            ? format.dateTime(new Date(person.respondedAt), {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : t("notYet")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })
      )}
      {asking ? (
        <AvailabilityPollDialog
          org={org}
          projects={projects}
          people={people}
          today={today}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  );
}
