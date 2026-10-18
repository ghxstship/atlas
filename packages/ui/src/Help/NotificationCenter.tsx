import { type KeyboardEvent, type ReactElement } from "react";
import type { NotificationItem } from "../types/reference";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { Tabs } from "../Navigation/Navigation.tsx";
import { type NotificationCenterProps } from "./Help.types.ts";

function NotificationList({
  items,
  onAction,
  onDone,
  onSnooze,
}: { items: NotificationItem[] } & Omit<NotificationCenterProps, "needsYou" | "fyi">) {
  const t = useT();
  const onKey = (e: KeyboardEvent<HTMLLIElement>, item: NotificationItem) => {
    if (e.target !== e.currentTarget) return;
    const key = e.key.toLowerCase();
    if (key === "e") onDone?.(item);
    else if (key === "h") onSnooze?.(item);
    else if (e.key === "Enter") onAction?.(item);
    else return;
    e.preventDefault();
  };
  return (
    <ul className="m-0 p-0 list-none">
      {items.map((item, i) => (
        <li
          key={`${item.title}-${i}`}
          tabIndex={0}
          onKeyDown={(e) => onKey(e, item)}
          className="xos-notif-item flex items-center gap-8 py-8 ps-16 pe-8 border-t border-border-subtle first:border-t-0 focus-visible:outline-offset-[calc(var(--stroke-width-focus)*-1)]"
        >
          {item.kind ? (
            <RecordKindGlyph kind={item.kind} color="var(--color-text-secondary)" />
          ) : (
            <Icon name="Bell" />
          )}
          <div className="xos-notif-text flex flex-1 flex-col min-w-0">
            <span className="truncate">{item.title}</span>
            <span className="text-text-secondary">{item.meta}</span>
          </div>
          {item.action ? (
            <Button
              size="sm"
              onClick={() => onAction?.(item)}
              {...(item.actionKey ? { shortcut: item.actionKey } : {})}
            >
              {item.action}
            </Button>
          ) : null}
          <IconButton
            icon="Check"
            label={t("action.done")}
            shortcut="E"
            onClick={() => onDone?.(item)}
          />
          <IconButton
            icon="AlarmClock"
            label={t("action.snooze")}
            shortcut="H"
            onClick={() => onSnooze?.(item)}
          />
        </li>
      ))}
    </ul>
  );
}

/** Needs You and For Your Information. On a focused item E marks it done, H snoozes it and Enter runs its action. */
export function NotificationCenter({
  needsYou,
  fyi,
  ...handlers
}: NotificationCenterProps): ReactElement {
  const t = useT();
  return (
    <section
      aria-label={t("inbox.label")}
      className="xos-notif w-(--ui-empty) max-w-full box-border rounded-card border border-border-subtle bg-bg-raised"
    >
      <div className="px-16">
        <Tabs
          label={t("inbox.label")}
          value="needs"
          tabs={[
            { value: "needs", label: t("inbox.needsYou"), count: needsYou.length },
            { value: "fyi", label: t("inbox.fyi"), count: fyi.length },
          ]}
          panels={{
            needs: <NotificationList items={needsYou} {...handlers} />,
            fyi: <NotificationList items={fyi} {...handlers} />,
          }}
        />
      </div>
    </section>
  );
}
