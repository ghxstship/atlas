import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { panelClass } from "./Gateway.shared.tsx";
import { type OpportunityCardProps } from "./Gateway.types.ts";

/** Role, pay, date and place, then a requirements check that shows exactly what is missing. No posted pay reads Rate on Request. */
export function OpportunityCard({
  org,
  verified,
  role,
  pay,
  date,
  place,
  requirements,
  missingAction,
  deadline,
  saved,
  onApply,
  onSave,
}: OpportunityCardProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const missing = requirements.missing.length > 0;
  return (
    <article className={cx(panelClass, "gap-8 w-(--ui-gateway-aside) p-16 text-text-14")}>
      <header className="flex items-center justify-between gap-8">
        <span className="flex items-center gap-6 min-w-0">
          <BrandMark name={org} size="sm" iconOnly />
          <span className="truncate">{org}</span>
          {verified ? (
            <span className="text-state-scheduled">
              <Icon name="BadgeCheck" size={14} label={t("org.verified")} />
            </span>
          ) : null}
        </span>
        <IconButton
          icon="Bookmark"
          label={saved ? t("action.saved") : t("action.save")}
          aria-pressed={saved ?? false}
          onClick={onSave}
        />
      </header>
      <h3 className="m-0 text-heading-16 font-semibold">{role}</h3>
      <div className="flex flex-wrap gap-x-12 gap-y-4 text-text-secondary">
        <strong className="text-text-primary tabular-nums">
          {pay ?? t("money.rateOnRequest")}
        </strong>
        <span>{date}</span>
        <span>{place}</span>
      </div>
      <div className="flex items-center gap-6 px-8 py-6 rounded-control bg-bg-surface text-text-13">
        <span className={missing ? "text-warning" : "text-success"}>
          <Icon name={missing ? "CircleAlert" : "CircleCheck"} size={14} />
        </span>
        <span>
          {missing
            ? t("opp.missing", { list: fmt.list(requirements.missing) })
            : t("opp.qualified")}
        </span>
      </div>
      <footer className="flex items-center justify-between gap-8">
        <span className="text-text-secondary">{deadline}</span>
        <Button variant="primary" onClick={onApply}>
          {missingAction && missing ? missingAction : t("opp.apply")}
        </Button>
      </footer>
    </article>
  );
}
