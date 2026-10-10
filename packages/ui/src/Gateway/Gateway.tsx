import { useState, type ReactElement } from "react";
import type {
  AgencySlateProps as ReferenceAgencySlateProps,
  ApplicationFormProps as ReferenceApplicationFormProps,
  AvailabilityCalendarProps as ReferenceAvailabilityCalendarProps,
  EngagementTimelineProps as ReferenceEngagementTimelineProps,
  EPKViewerProps as ReferenceEPKViewerProps,
  OnboardingPacketProps as ReferenceOnboardingPacketProps,
  OpportunityCardProps as ReferenceOpportunityCardProps,
  OpportunityFiltersProps as ReferenceOpportunityFiltersProps,
  PaymentTrackerProps as ReferencePaymentTrackerProps,
  PayoutDetailsFormProps as ReferencePayoutDetailsFormProps,
  ProfileEditorProps as ReferenceProfileEditorProps,
  ProgressBarProps as ReferenceProgressBarProps,
  RatingDialogProps as ReferenceRatingDialogProps,
  UpNextCardProps as ReferenceUpNextCardProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useLocale, useT } from "../lib/context.tsx";
import { monthCells, monthTitle, parseIso, toIso, weekdayNames } from "../lib/format.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { Tag, chipClass } from "../Chips/Chips.tsx";
import { Card } from "../Surface/Surface.tsx";
import { Checkbox, Input, Money, Select, Textarea } from "../Forms/Forms.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { Dialog } from "../Overlays/Overlays.tsx";
import { linkClass } from "../Link/Link.tsx";
import { PropertyList } from "../Overlays/Overlays.tsx";

export type ProgressBarProps = ReferenceProgressBarProps;
export type OpportunityCardProps = ReferenceOpportunityCardProps & {
  onApply?: () => void;
  onSave?: () => void;
};
export type OpportunityFiltersProps = ReferenceOpportunityFiltersProps & {
  onSearch?: (query: string) => void;
  onChipsChange?: (active: string[]) => void;
  onViewChange?: (view: "cards" | "map") => void;
};
export type ApplicationFormProps = ReferenceApplicationFormProps & { onSubmit?: () => void };
export type AgencySlateProps = ReferenceAgencySlateProps & {
  onChange?: (selected: string[]) => void;
  onSubmit?: (selected: string[]) => void;
};
export type ProfileEditorProps = ReferenceProfileEditorProps & {
  onVisibilityChange?: (label: string, visibility: "private" | "application" | "public") => void;
};
export type EPKViewerProps = ReferenceEPKViewerProps & { onMedia?: (label: string) => void };
export type AvailabilityCalendarProps = ReferenceAvailabilityCalendarProps;
export type OnboardingPacketProps = ReferenceOnboardingPacketProps & {
  onStart?: (label: string) => void;
};
export type EngagementTimelineProps = ReferenceEngagementTimelineProps;
export type RatingDialogProps = ReferenceRatingDialogProps & {
  onSubmit?: (rating: number, comment: string) => void;
  onLater?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};
export type PayoutDetailsFormProps = ReferencePayoutDetailsFormProps & {
  onSave?: (details: { routing: string; account: string; type: string }) => void;
};
export type PaymentTrackerProps = ReferencePaymentTrackerProps;
export type UpNextCardProps = ReferenceUpNextCardProps & {
  onDirections?: () => void;
  onCalendar?: () => void;
  onWallet?: () => void;
};

const panelClass = cx(
  "flex flex-col box-border max-w-full rounded-dialog border border-border-subtle bg-bg-raised",
);

/** Determinate progress with its percentage. */
export function ProgressBar({ label, value }: ProgressBarProps): ReactElement {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex flex-col gap-6 w-(--ui-field) max-w-full">
      <div className="flex justify-between text-text-12 text-text-secondary">
        <span>{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-(--space-4) rounded-pill bg-bg-hover overflow-hidden"
      >
        <div
          className="h-full rounded-pill bg-accent forced-colors:bg-[Highlight]"
          style={{ inlineSize: `${pct}%` }}
        />
      </div>
    </div>
  );
}

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

/** Search, filter chips and the cards or map view. */
export function OpportunityFilters({
  placeholder: hint,
  chips,
  active = [],
  onSearch,
  onChipsChange,
  onViewChange,
}: OpportunityFiltersProps): ReactElement {
  const t = useT();
  const [on, setOn] = useState(active);
  return (
    <div role="group" aria-label={t("filter.label")} className="flex flex-wrap items-center gap-8">
      <label className="flex items-center gap-8 w-(--ui-skeleton-inline) min-w-0 grow h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring">
        <Icon name="Search" color="var(--color-text-secondary)" />
        <input
          aria-label={t("opp.search")}
          placeholder={hint}
          onChange={(e) => onSearch?.(e.target.value)}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
        />
      </label>
      {chips.map((chip) => {
        const pressed = on.includes(chip);
        return (
          <button
            key={chip}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              const next = pressed ? on.filter((c) => c !== chip) : [...on, chip];
              setOn(next);
              onChipsChange?.(next);
            }}
            className={cx(
              "inline-flex items-center gap-4 h-control-md px-12 rounded-pill border border-border-control bg-transparent cursor-pointer",
              "font-medium text-text-13 text-text-secondary pointer-coarse:min-h-target-coarse",
              "aria-pressed:bg-text-primary aria-pressed:text-bg-canvas aria-pressed:border-text-primary",
            )}
          >
            {pressed ? <Icon name="Check" size={12} /> : null}
            {chip}
          </button>
        );
      })}
      <SegmentedControl
        label={t("view.label")}
        value="cards"
        onChange={(v) => onViewChange?.(v === "map" ? "map" : "cards")}
        options={[
          { value: "cards", label: t("view.cards"), icon: "LayoutGrid" },
          { value: "map", label: t("view.map"), icon: "Map" },
        ]}
      />
    </div>
  );
}

/** What the person shares before applying, the org's questions and availability confirmation. */
export function ApplicationForm({
  role,
  org,
  shared,
  questions,
  onSubmit,
}: ApplicationFormProps): ReactElement {
  const t = useT();
  return (
    <Card
      title={t("apply.title", { role })}
      meta={org}
      footer={
        <>
          <span className="me-auto text-text-secondary">{t("apply.draftSaved")}</span>
          <Button variant="primary" onClick={onSubmit}>
            {t("apply.submit")}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 p-0 border-0 flex flex-col gap-8">
        <legend className="mb-8 text-text-12 font-medium text-text-secondary">
          {t("apply.shared", { org })}
        </legend>
        <ul className="grid grid-cols-2 max-sm:grid-cols-1 gap-8 m-0 px-12 py-8 list-none rounded-control bg-bg-surface">
          {shared.map((s) => (
            <li key={s.label}>
              <Checkbox label={s.label} defaultChecked={s.on} />
            </li>
          ))}
        </ul>
      </fieldset>
      {questions.map((q) => (
        <Textarea key={q} label={q} width="100%" rows={2} />
      ))}
      <Checkbox label={t("apply.available")} />
    </Card>
  );
}

/** Named staff from an agency roster against the positions, with certification status. */
export function AgencySlate({
  positions,
  roster,
  onChange,
  onSubmit,
}: AgencySlateProps): ReactElement {
  const t = useT();
  const [selected, setSelected] = useState(roster.filter((r) => r.selected).map((r) => r.name));
  const toggle = (name: string) => {
    const next = selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
    setSelected(next);
    onChange?.(next);
  };
  return (
    <Card
      title={t("slate.title")}
      meta={t("slate.positions", { n: selected.length, total: positions })}
      footer={
        <Button
          variant="primary"
          disabled={selected.length === 0}
          onClick={() => onSubmit?.(selected)}
        >
          {t("slate.submit")}
        </Button>
      }
    >
      <ProgressBar
        label={t("slate.filled")}
        value={positions ? (selected.length / positions) * 100 : 0}
      />
      <ul className="m-0 p-0 list-none">
        {roster.map((r) => (
          <li
            key={r.name}
            className="flex flex-wrap items-center gap-8 min-h-touch-min border-b border-border-subtle last:border-b-0"
          >
            <label className="xos-check inline-flex items-center">
              <input
                type="checkbox"
                className="xos-check-input"
                checked={selected.includes(r.name)}
                onChange={() => toggle(r.name)}
                aria-label={t("slate.include", { name: r.name })}
              />
            </label>
            <Avatar name={r.name} />
            <div className="flex flex-1 flex-col min-w-0">
              <strong className="font-semibold">{r.name}</strong>
              <span className="text-text-secondary">{r.role}</span>
            </div>
            {r.certs.map((c) => (
              <span key={c.label} className={chipClass}>
                <span className={c.ok ? "text-success" : "text-warning"}>
                  <Icon name={c.ok ? "BadgeCheck" : "CircleAlert"} size={12} />
                </span>
                {c.label}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Each field's visibility (Private, On Apply, Public) with a strength meter naming the next step. */
export function ProfileEditor({
  strength,
  nextStep,
  fields,
  onVisibilityChange,
}: ProfileEditorProps): ReactElement {
  const t = useT();
  const options = [
    { value: "private", label: t("visibility.private") },
    { value: "application", label: t("visibility.application") },
    { value: "public", label: t("visibility.public") },
  ];
  return (
    <Card title={t("profile.title")} meta={t("profile.complete", { n: strength })}>
      <ProgressBar label={nextStep} value={strength} />
      {fields.map((f) => (
        <div
          key={f.label}
          className="flex flex-wrap items-center gap-12 py-8 border-b border-border-subtle last:border-b-0"
        >
          <div className="flex flex-1 flex-col min-w-0">
            <span className="text-text-12 font-medium text-text-secondary">{f.label}</span>
            <span>{f.value}</span>
          </div>
          <SegmentedControl
            label={f.label}
            value={f.visibility}
            options={options}
            onChange={(v) =>
              onVisibilityChange?.(f.label, v as "private" | "application" | "public")
            }
          />
        </div>
      ))}
    </Card>
  );
}

const TILE_SEQ = [cx("bg-viz-seq-9"), cx("bg-viz-seq-8"), cx("bg-viz-seq-7"), cx("bg-viz-seq-6")];

/** An artist's press kit: media grid, bio, verified badges and links. */
export function EPKViewer({
  artist,
  headline,
  badges,
  bio,
  media,
  links,
  onMedia,
}: EPKViewerProps): ReactElement {
  return (
    <section aria-label={artist} className="flex flex-col gap-16 max-w-(--layout-form)">
      <header className="flex flex-wrap items-center gap-8">
        <Avatar name={artist} size="lg" />
        <div className="flex flex-col">
          <h2 className="m-0 text-heading-20 font-semibold">{artist}</h2>
          <span className="text-text-secondary">{headline}</span>
        </div>
        <span className="ms-auto flex flex-wrap gap-4">
          {badges.map((b) => (
            <span key={b} className={chipClass}>
              <span className="text-success">
                <Icon name="BadgeCheck" size={12} />
              </span>
              {b}
            </span>
          ))}
        </span>
      </header>
      <div className="grid grid-cols-4 max-sm:grid-cols-2 gap-8">
        {media.map((m, i) => (
          <button
            key={`${m.label}-${i}`}
            type="button"
            onClick={() => onMedia?.(m.label)}
            className={cx(
              "flex aspect-square flex-col items-center justify-center gap-6 rounded-card border-0 cursor-pointer",
              "text-accent-text-on font-medium text-text-12",
              TILE_SEQ[i % 4],
            )}
          >
            <Icon
              name={m.type === "video" ? "Play" : m.type === "audio" ? "AudioLines" : "Image"}
              size={20}
            />
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <p className="m-0 text-text-secondary">{bio}</p>
      <div className="flex flex-wrap gap-8">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            className={linkClass}
            target="_blank"
            rel="noopener noreferrer"
          >
            {l.label}
            <Icon name="ExternalLink" size={12} />
          </a>
        ))}
      </div>
    </section>
  );
}

/** Available and booked days; booked days are struck through as well as colored. */
export function AvailabilityCalendar({
  month,
  available,
  booked,
}: AvailabilityCalendarProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const { y, m } = parseIso(month);
  const title = monthTitle(locale, y, m);
  return (
    <div className="flex flex-col gap-12 w-(--ui-popover) max-w-full">
      <strong className="font-semibold">{title}</strong>
      <table aria-label={title} className="border-collapse">
        <thead>
          <tr>
            {weekdayNames(locale).map((d) => (
              <th
                key={d}
                scope="col"
                className="h-control-sm text-text-11 font-medium text-text-tertiary"
              >
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthCells(locale, y, m).map((week, wi) => (
            <tr key={wi}>
              {week.map((d, di) => {
                if (d === null) return <td key={di} />;
                const iso = toIso(y, m, d);
                const isBooked = booked.includes(iso);
                const isAvailable = !isBooked && available.includes(iso);
                return (
                  <td key={di} className="p-0 text-center">
                    <span
                      className={cx(
                        "inline-grid place-items-center w-(--ui-day-inline) h-(--ui-day-block) rounded-control tabular-nums",
                        isBooked && "bg-bg-hover text-text-tertiary line-through",
                        isAvailable && "ring-(length:--ui-hairline-half) ring-inset ring-success",
                      )}
                    >
                      {d}
                      {isBooked || isAvailable ? (
                        <span className="sr-only">
                          {` ${isBooked ? t("availability.booked") : t("availability.available")}`}
                        </span>
                      ) : null}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-8 text-text-secondary">
        <span className="inline-flex items-center gap-4">
          <span
            aria-hidden="true"
            className="inline-block size-icon-12 rounded-mark ring-(length:--ui-hairline-half) ring-inset ring-success"
          />
          {t("availability.available")}
        </span>
        <span className="inline-flex items-center gap-4">
          <span aria-hidden="true" className="inline-block size-icon-12 rounded-mark bg-bg-hover" />
          {t("availability.booked")}
        </span>
      </div>
    </div>
  );
}

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

/** The engagement stages and where this engagement is. */
export function EngagementTimeline({ current, stages }: EngagementTimelineProps): ReactElement {
  const t = useT();
  return (
    <ol aria-label={t("engagement.stages")} className="flex flex-col m-0 p-0 list-none">
      {stages.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={s.label}
            aria-current={state === "current" ? "step" : undefined}
            className={cx(
              "relative flex items-start gap-12 py-6 text-text-secondary",
              state === "current" && "text-text-primary font-medium",
            )}
          >
            <span
              className={cx(
                "inline-grid place-items-center flex-none size-icon-20 rounded-full text-text-11 font-semibold tabular-nums",
                state === "todo" &&
                  "ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                state === "current" && "bg-accent text-accent-text-on",
                state === "done" && "bg-bg-hover text-success",
              )}
            >
              {state === "done" ? <Icon name="Check" size={12} /> : i + 1}
            </span>
            <div className="flex flex-col">
              <strong className="font-semibold">{s.label}</strong>
              <span className="text-text-secondary">{s.date ?? s.owner}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

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

/** Bank details in a secure form; after saving only the last four digits are shown. */
export function PayoutDetailsForm({ rail, onFile, onSave }: PayoutDetailsFormProps): ReactElement {
  const t = useT();
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [type, setType] = useState("checking");
  return (
    <Card
      title={t("payout.title")}
      meta={rail}
      footer={
        <Button variant="primary" icon="Lock" onClick={() => onSave?.({ routing, account, type })}>
          {t("payout.save")}
        </Button>
      }
    >
      {onFile ? (
        <div className={cx(chipClass, "h-control-lg self-start")}>
          <Icon name="Landmark" size={14} />
          <span>{onFile.bank}</span>
          <span className="font-mono">•••• {onFile.last4}</span>
        </div>
      ) : null}
      <Input
        label={t("payout.routing")}
        inputMode="numeric"
        autoComplete="off"
        placeholder={t("payout.routingHint")}
        value={routing}
        onChange={(e) => setRouting(e.target.value)}
      />
      <Input
        label={t("payout.account")}
        inputMode="numeric"
        autoComplete="off"
        type="password"
        help={t("payout.accountHelp")}
        value={account}
        onChange={(e) => setAccount(e.target.value)}
      />
      <Select
        label={t("payout.type")}
        value="checking"
        options={[
          { value: "checking", label: t("payout.checking") },
          { value: "savings", label: t("payout.savings") },
        ]}
        onChange={(e) => setType(e.target.value)}
      />
    </Card>
  );
}

/** A payment followed like a package: Submitted, Approved, Scheduled, Paid. */
export function PaymentTracker({
  invoiceKey,
  title,
  amount,
  current,
  dates,
  expected,
}: PaymentTrackerProps): ReactElement {
  const t = useT();
  const steps = [t("pay.submitted"), t("pay.approved"), t("pay.scheduled"), t("pay.paid")];
  return (
    <section
      aria-label={t("pay.label", { key: invoiceKey })}
      className="flex flex-col gap-16 w-(--ui-alert) max-w-full p-16 box-border rounded-card border border-border-subtle bg-bg-raised"
    >
      <div className="flex items-start justify-between gap-8">
        <div className="flex flex-col">
          <span className="font-mono text-text-12 text-text-secondary">{invoiceKey}</span>
          <strong className="font-semibold">{title}</strong>
        </div>
        <strong className="text-heading-20 font-semibold tabular-nums">
          <Money amount={amount} />
        </strong>
      </div>
      <ol className="grid grid-cols-4 gap-8 m-0 p-0 list-none">
        {steps.map((s, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          const note =
            dates[i] ??
            (state === "todo" && expected && i === current + 1
              ? t("pay.expected", { date: expected })
              : "");
          return (
            <li
              key={s}
              aria-current={state === "current" ? "step" : undefined}
              className={cx(
                "flex flex-col gap-6 pt-4 text-text-12 border-t-stroke-accent",
                state === "done" && "border-t-success",
                state === "current" && "border-t-accent font-medium",
                state === "todo" && "border-t-border-subtle text-text-secondary",
              )}
            >
              <span
                className={cx(
                  "inline-grid place-items-center size-icon-20 rounded-full text-text-11 font-semibold tabular-nums",
                  state === "todo" &&
                    "ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                  state === "current" && "bg-accent text-accent-text-on",
                  state === "done" && "bg-bg-hover text-success",
                )}
              >
                {state === "done" ? <Icon name="Check" size={12} /> : i + 1}
              </span>
              <span>{s}</span>
              <span className="text-text-secondary tabular-nums">{note}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

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
