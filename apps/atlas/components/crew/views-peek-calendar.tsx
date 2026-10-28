"use client";

import { Calendar, type RecordState } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useHoverCards, type RecordPreview } from "@/components/hover/use-hover-cards";
import { useRowMenu } from "@/components/menus/use-row-menu";
import { useQueryHref } from "./views.shared";

/**
 * A month calendar whose events open the side peek. An event's menu (right-click, Shift+F10) offers
 * what its table row's does, and an event with a `preview` shows it as a hover card after 400 ms
 * (Section 11.7).
 */
export function PeekCalendar(props: {
  month: string;
  today: string;
  events: Array<{
    id: string;
    date: string;
    label: string;
    state: RecordState;
    preview?: RecordPreview;
  }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  const rowMenu = useRowMenu();
  const byId = new Map(props.events.map((e) => [e.id, e]));
  const hover = useHoverCards((id) => {
    const preview = byId.get(id)?.preview;
    return preview ? { kind: "record", ...preview } : null;
  });
  return (
    <div {...hover.hoverProps}>
      <Calendar
        month={props.month}
        today={props.today}
        events={props.events.map(({ id, date, label, state }) => ({ id, date, label, state }))}
        onEventSelect={(e) => {
          if (e.id) router.push(href({ peek: e.id, full: null }));
        }}
        onItemContextMenu={(id, at, element) =>
          rowMenu.open(
            {
              id,
              label: byId.get(id)?.label ?? id,
              open: () => router.push(href({ peek: id, full: null })),
              href: href({ peek: id, full: "1" }),
            },
            at,
            element,
          )
        }
      />
      {rowMenu.menu}
      {hover.card}
    </div>
  );
}
