import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { PropertyList } from "../Overlays/Overlays.tsx";
import { panelClass } from "./Gateway.shared.tsx";
import { type UpNextCardProps } from "./Gateway.types.ts";

/** Leads Gateway Home with the next shift: countdown, call time, address and what to bring. */
export function UpNextCard({
  org,
  countdown,
  title,
  when,
  callTime,
  address,
  parking,
  contact,
  bring,
  onDirections,
  onCalendar,
  onWallet,
}: UpNextCardProps): ReactElement {
  const t = useT();
  const properties = [
    { label: t("upnext.when"), value: <span className="tabular-nums">{when}</span> },
    { label: t("upnext.call"), value: <span className="tabular-nums">{callTime}</span> },
    { label: t("upnext.where"), value: address },
    ...(parking ? [{ label: t("upnext.parking"), value: parking }] : []),
    ...(contact ? [{ label: t("upnext.contact"), value: contact }] : []),
  ];
  return (
    <article
      aria-label={t("upnext.label")}
      className={cx(panelClass, "gap-12 w-(--ui-gateway-aside) p-16 text-text-14")}
    >
      <header className="flex items-center justify-between gap-8">
        <span className="flex items-center gap-6">
          <BrandMark name={org} size="sm" iconOnly />
          <span className="text-text-12 font-medium text-text-secondary">{t("upnext.label")}</span>
        </span>
        <span className="font-semibold text-accent-text tabular-nums">{countdown}</span>
      </header>
      <h3 className="m-0 text-heading-20 font-semibold">{title}</h3>
      <PropertyList items={properties} />
      {bring && bring.length ? (
        <div className="flex flex-col gap-4">
          <span className="text-text-12 font-medium text-text-secondary">{t("upnext.bring")}</span>
          <ul className="flex flex-col gap-4 m-0 p-0 list-none">
            {bring.map((b) => (
              <li key={b} className="flex items-center gap-6">
                <span className="text-success">
                  <Icon name="Check" size={14} />
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center gap-8">
        <Button variant="primary" icon="Navigation" onClick={onDirections}>
          {t("upnext.directions")}
        </Button>
        <Button icon="CalendarPlus" onClick={onCalendar}>
          {t("upnext.calendar")}
        </Button>
        <Button icon="Wallet" onClick={onWallet}>
          {t("badge.wallet")}
        </Button>
      </footer>
    </article>
  );
}
