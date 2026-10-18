import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Textarea } from "../Forms/Forms.tsx";
import { Dialog } from "../Overlays/Overlays.tsx";
import { type RatingDialogProps } from "./Gateway.types.ts";

/** A two-sided rating after close-out; stars are a radio group, both ratings release together. */
export function RatingDialog({
  counterpart,
  value = 0,
  onSubmit,
  onLater,
  open,
  onOpenChange,
}: RatingDialogProps): ReactElement {
  const t = useT();
  const [rating, setRating] = useState(value);
  const [comment, setComment] = useState("");
  return (
    <Dialog
      title={t("rating.title", { name: counterpart })}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      actions={
        <>
          <Button variant="ghost" onClick={onLater}>
            {t("action.later")}
          </Button>
          <Button variant="primary" disabled={!rating} onClick={() => onSubmit?.(rating, comment)}>
            {t("rating.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <div role="radiogroup" aria-label={t("rating.label")} className="flex gap-4">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              tabIndex={rating === n || (rating === 0 && n === 1) ? 0 : -1}
              aria-label={t(n === 1 ? "rating.star" : "rating.stars", { n })}
              onClick={() => setRating(n)}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight" || e.key === "ArrowUp"
                    ? Math.min(5, n + 1)
                    : e.key === "ArrowLeft" || e.key === "ArrowDown"
                      ? Math.max(1, n - 1)
                      : null;
                if (next === null) return;
                e.preventDefault();
                setRating(next);
                (
                  e.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined
                )?.focus();
              }}
              className={cx(
                "grid place-items-center size-(--density-target-coarse) rounded-control border-0 bg-transparent cursor-pointer text-text-tertiary",
                n <= rating && "text-warning [&_svg]:fill-current",
              )}
            >
              <Icon name="Star" size={24} />
            </button>
          ))}
        </div>
        <Textarea
          label={t("rating.comment")}
          width="100%"
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <span className="text-text-12 text-text-secondary">{t("rating.release")}</span>
      </div>
    </Dialog>
  );
}
