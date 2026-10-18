import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Tag } from "../Chips/Chips.tsx";
import { Card } from "../Surface/Surface.tsx";
import { type OnboardingPacketProps } from "./Gateway.types.ts";
import { ProgressBar } from "./ProgressBar.tsx";

const PACKET: Record<
  "verified" | "review" | "todo" | "expired",
  { icon: string; className: string; key: string }
> = {
  verified: { icon: "CircleCheck", className: cx("text-success"), key: "packet.verified" },
  review: { icon: "Eye", className: cx("text-state-in-review"), key: "packet.review" },
  todo: { icon: "Circle", className: cx("text-text-tertiary"), key: "packet.todo" },
  expired: { icon: "CircleAlert", className: cx("text-danger"), key: "packet.expired" },
};

/** Each onboarding requirement with a time estimate; blocking items gate the engagement. */
export function OnboardingPacket({ items, onStart }: OnboardingPacketProps): ReactElement {
  const t = useT();
  const done = items.filter((i) => i.state === "verified").length;
  const minutes = items.filter((i) => i.state === "todo").reduce((sum, i) => sum + i.minutes, 0);
  return (
    <Card title={t("packet.title")} meta={t("packet.minutesLeft", { n: minutes })}>
      <ProgressBar
        label={t("packet.verifiedCount", { n: done, total: items.length })}
        value={items.length ? (done / items.length) * 100 : 0}
      />
      <ul className="flex flex-col m-0 p-0 list-none">
        {items.map((item) => {
          const s = PACKET[item.state];
          return (
            <li
              key={item.label}
              className="flex items-center gap-8 min-h-(--space-40) border-b border-border-subtle last:border-b-0"
            >
              <span className={s.className}>
                <Icon name={s.icon} label={t(s.key)} />
              </span>
              <div className="flex flex-1 flex-col min-w-0">
                <span>{item.label}</span>
                <span className="text-text-secondary">
                  {item.note ?? t("packet.minutes", { n: item.minutes })}
                </span>
              </div>
              {item.blocking ? <Tag>{t("packet.required")}</Tag> : null}
              {item.state === "todo" ? (
                <Button size="sm" onClick={() => onStart?.(item.label)}>
                  {item.action ?? t("action.start")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
