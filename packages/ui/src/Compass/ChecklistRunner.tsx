import { useEffect, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Textarea } from "../Forms/Forms.tsx";
import { Phone } from "./Compass.shared.tsx";
import { type ChecklistRunnerProps } from "./Compass.types.ts";

function BigChoice({
  pass,
  on,
  label,
  onClick,
}: {
  pass: boolean;
  on: boolean;
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "flex flex-col items-center justify-center gap-4 h-(--ui-compass-thumb) border-0 rounded-dialog",
        "text-heading-20 font-semibold cursor-pointer text-text-primary forced-colors:border forced-colors:border-[CanvasText]",
        "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        on
          ? cx(
              "bg-bg-hover ring-(length:--stroke-width-focus) ring-inset",
              pass ? "ring-success" : "ring-danger",
            )
          : "bg-bg-surface ring-(length:--ui-hairline-half) ring-inset ring-border-control",
      )}
    >
      <Icon
        name={pass ? "Check" : "X"}
        size={28}
        className={pass ? "text-success" : "text-danger"}
      />
      {label}
    </button>
  );
}

/** Inspection runner: one item per card, large Pass and Fail; a Fail asks for a photo and a note. */
export function ChecklistRunner({
  frame,
  title,
  index,
  items,
  onResult,
  onAddPhoto,
  onNoteChange,
}: ChecklistRunnerProps): ReactElement {
  const t = useT();
  const [results, setResults] = useState(() => items.map((i) => i.result));
  useEffect(() => setResults(items.map((i) => i.result)), [items]);
  const item = items[index];
  const done = results.filter(Boolean).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  const result = results[index] ?? null;
  const choose = (next: "pass" | "fail") => {
    if (!item) return;
    setResults((prev) => prev.map((r, i) => (i === index ? next : r)));
    onResult?.(item.code, next);
  };
  return (
    <Phone frame={frame}>
      <div className="flex flex-col gap-12 p-16">
        <div className="flex justify-between text-text-12 text-text-secondary">
          <strong className="text-text-primary">{title}</strong>
          <span className="tabular-nums">
            {t("count.of", { n: index + 1, total: items.length })}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-4 rounded-pill bg-bg-hover overflow-hidden"
        >
          <div
            className="h-full rounded-pill bg-accent forced-colors:bg-[CanvasText]"
            style={{ inlineSize: `${percent}%` }}
          />
        </div>
        {item ? (
          <article className="flex flex-col gap-8 p-20 min-h-(--ui-compass-card-min) bg-bg-raised border border-border-subtle rounded-dialog">
            <span className="font-mono text-mono-12 text-text-secondary">{item.code}</span>
            <strong className="text-heading-20 font-semibold">{item.label}</strong>
            {item.help ? <span className="text-text-secondary">{item.help}</span> : null}
            {result === "fail" ? (
              <div className="flex flex-col gap-8">
                <Button icon="Camera" size="lg" onClick={() => onAddPhoto?.(item.code)}>
                  {t("inspection.addPhoto")}
                </Button>
                <Textarea
                  label={t("inspection.whatFailed")}
                  width="100%"
                  onChange={(e) => onNoteChange?.(item.code, e.target.value)}
                />
              </div>
            ) : null}
          </article>
        ) : null}
        <div className="grid grid-cols-2 gap-12">
          <BigChoice
            pass={false}
            on={result === "fail"}
            label={t("inspection.fail")}
            onClick={() => choose("fail")}
          />
          <BigChoice
            pass
            on={result === "pass"}
            label={t("inspection.pass")}
            onClick={() => choose("pass")}
          />
        </div>
      </div>
    </Phone>
  );
}
