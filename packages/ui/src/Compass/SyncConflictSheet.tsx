import { useId, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { Phone, SheetFrame, blockClass } from "./Compass.shared.tsx";
import { type SyncConflictSheetProps } from "./Compass.types.ts";

/** Resolves an offline write that collided with a newer server value. */
export function SyncConflictSheet({
  frame,
  message,
  field,
  mine,
  mineMeta,
  theirs,
  theirsMeta,
  onKeep,
}: SyncConflictSheetProps): ReactElement {
  const t = useT();
  const [choice, setChoice] = useState<"mine" | "theirs">("mine");
  const name = useId();
  const options = [
    { value: "mine" as const, who: t("conflict.yours"), value_: mine, meta: mineMeta },
    { value: "theirs" as const, who: t("conflict.server"), value_: theirs, meta: theirsMeta },
  ];
  return (
    <Phone frame={frame}>
      <SheetFrame title={t("conflict.title")}>
        <p className="m-0 text-text-secondary">{message}</p>
        <span className="text-label-13 font-medium">{field}</span>
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              "flex items-center gap-12 p-12 border rounded-card cursor-pointer",
              choice === o.value ? "border-accent bg-bg-hover" : "border-border-control",
            )}
          >
            <input
              type="radio"
              name={name}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
              className="size-icon-20 accent-(--color-accent-default)"
            />
            <div className="flex flex-col">
              <span className="text-text-secondary">
                {o.who} · {o.meta}
              </span>
              <strong>{o.value_}</strong>
            </div>
          </label>
        ))}
        <Button variant="primary" size="lg" className={blockClass} onClick={() => onKeep?.(choice)}>
          {t("conflict.keep")}
        </Button>
      </SheetFrame>
    </Phone>
  );
}
