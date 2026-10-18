"use client";

import { Calendar, type RecordState } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useQueryHref } from "./views.shared";

/** A month calendar whose events open the side peek. */
export function PeekCalendar(props: {
  month: string;
  today: string;
  events: Array<{ id: string; date: string; label: string; state: RecordState }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Calendar
      month={props.month}
      today={props.today}
      events={props.events}
      onEventSelect={(e) => {
        const found = props.events.find((x) => x.date === e.date && x.label === e.label);
        if (found) router.push(href({ peek: found.id, full: null }));
      }}
    />
  );
}
