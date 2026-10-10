import { useState, type KeyboardEvent, type ReactElement } from "react";
import type {
  FeedbackWidgetProps as ReferenceFeedbackWidgetProps,
  HelpPanelProps as ReferenceHelpPanelProps,
  NotificationCenterProps as ReferenceNotificationCenterProps,
  NotificationItem,
  OnboardingChecklistProps as ReferenceOnboardingChecklistProps,
  ShortcutEditorProps as ReferenceShortcutEditorProps,
  WhatsNewProps as ReferenceWhatsNewProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { Tag } from "../Chips/Chips.tsx";
import { Card, cardBodyClass, cardClass, cardHeadClass } from "../Surface/Surface.tsx";
import { Checkbox, Textarea } from "../Forms/Forms.tsx";
import { Tabs } from "../Navigation/Navigation.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { linkClass } from "../Link/Link.tsx";

export type NotificationCenterProps = ReferenceNotificationCenterProps & {
  onAction?: (item: NotificationItem) => void;
  onDone?: (item: NotificationItem) => void;
  onSnooze?: (item: NotificationItem) => void;
};
export type OnboardingChecklistProps = ReferenceOnboardingChecklistProps & {
  onAction?: (label: string) => void;
};
export type WhatsNewProps = ReferenceWhatsNewProps;
export type FeedbackWidgetProps = ReferenceFeedbackWidgetProps & {
  onSend?: (feedback: { text: string; screenshot: boolean }) => void;
  onCancel?: () => void;
};
export type ShortcutEditorProps = ReferenceShortcutEditorProps & {
  onChange?: (action: string) => void;
  onReset?: (action: string) => void;
};
export type HelpPanelProps = ReferenceHelpPanelProps & {
  onSearch?: (query: string) => void;
  onArticle?: (title: string) => void;
  onAsk?: (question: string) => void;
  onWhatsNew?: () => void;
  onContact?: () => void;
  onClose?: () => void;
};

const searchFieldClass = cx(
  "flex items-center gap-8 h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface",
  "focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring",
);
const searchInputClass = cx(
  "flex-1 min-w-0 border-0 bg-transparent outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse",
);

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

/** First-run steps with progress; done steps are struck through. */
export function OnboardingChecklist({
  title,
  steps,
  onAction,
}: OnboardingChecklistProps): ReactElement {
  const t = useT();
  const done = steps.filter((s) => s.done).length;
  return (
    <Card title={title} meta={t("count.of", { n: done, total: steps.length })}>
      <div
        role="progressbar"
        aria-label={title}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        className="h-(--space-4) rounded-pill bg-bg-hover overflow-hidden"
      >
        <div
          className="h-full rounded-pill bg-accent"
          style={{ inlineSize: `${steps.length ? (done / steps.length) * 100 : 0}%` }}
        />
      </div>
      <ol className="flex flex-col m-0 p-0 list-none">
        {steps.map((s) => (
          <li
            key={s.label}
            className="flex items-center gap-8 min-h-(--space-40) border-b border-border-subtle last:border-b-0"
          >
            <span className={s.done ? "text-success" : "text-text-tertiary"}>
              <Icon
                name={s.done ? "CircleCheck" : "Circle"}
                {...(s.done ? { label: t("action.done") } : {})}
              />
            </span>
            <span className={cx("flex-1", s.done && "text-text-secondary line-through")}>
              {s.label}
            </span>
            {!s.done && s.action ? (
              <Button size="sm" onClick={() => onAction?.(s.label)}>
                {s.action}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Recent changes with a link to the full changelog. */
export function WhatsNew({ changelogHref, entries }: WhatsNewProps): ReactElement {
  const t = useT();
  return (
    <section aria-label={t("whatsNew.title")} className={cardClass}>
      <header className={cardHeadClass}>
        <h2 className="m-0 text-text-13 font-semibold">{t("whatsNew.title")}</h2>
        <a href={changelogHref} className={linkClass}>
          {t("whatsNew.changelog")}
        </a>
      </header>
      <div className={cardBodyClass}>
        {entries.map((e) => (
          <article key={e.title} className="flex flex-col gap-4">
            <div className="flex items-center gap-6">
              <Tag tone={e.tone ?? "accent"}>{e.label}</Tag>
              <span className="text-text-secondary">{e.date}</span>
            </div>
            <h3 className="m-0 text-text-13 font-semibold">{e.title}</h3>
            <p className="m-0 text-text-secondary">{e.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/** Feedback with a privacy note; only what the person chooses is sent. */
export function FeedbackWidget({ onSend, onCancel }: FeedbackWidgetProps): ReactElement {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState(false);
  return (
    <Card
      title={t("feedback.title")}
      footer={
        sent ? (
          <span role="status" className="flex items-center gap-6">
            <span className="text-success">
              <Icon name="CircleCheck" />
            </span>
            {t("feedback.thanks")}
          </span>
        ) : (
          <>
            <Button variant="ghost" onClick={onCancel}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={!text.trim()}
              onClick={() => {
                setSent(true);
                onSend?.({ text, screenshot });
              }}
            >
              {t("action.send")}
            </Button>
          </>
        )
      }
    >
      <Textarea
        label={t("feedback.question")}
        placeholder={t("feedback.hint")}
        width="100%"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Checkbox
        label={t("feedback.screenshot")}
        checked={screenshot}
        onChange={(e) => setScreenshot(e.target.checked)}
      />
      <span className="text-text-12 text-text-secondary">{t("feedback.privacy")}</span>
    </Card>
  );
}

/** Every action's shortcut with conflicts named in place; Change records new keys, Reset restores a custom one. */
export function ShortcutEditor({
  label,
  rows,
  onChange,
  onReset,
}: ShortcutEditorProps): ReactElement {
  const t = useT();
  const th = cx(
    "h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
  );
  const td = cx("h-row-default px-12 border-b border-border-subtle");
  return (
    <ScrollRegion label={label ?? t("shortcuts.title")}>
      <table className="w-full border-collapse text-text-13">
        <thead>
          <tr>
            <th scope="col" className={th}>
              {t("shortcutEditor.action")}
            </th>
            <th scope="col" className={th}>
              {t("shortcutEditor.shortcut")}
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">{t("shortcutEditor.edit")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.action}>
              <td className={td}>{r.action}</td>
              <td className={td}>
                <span className="inline-flex flex-wrap items-center gap-8">
                  <Keys keys={r.keys} />
                  {r.conflict ? (
                    <span className="inline-flex items-center gap-4 text-text-12 text-danger-text">
                      <Icon name="alert" size={12} />
                      {r.conflict}
                    </span>
                  ) : null}
                </span>
              </td>
              <td className={cx(td, "text-end whitespace-nowrap")}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={r.recording ?? false}
                  onClick={() => onChange?.(r.action)}
                >
                  {r.recording ? t("shortcutEditor.press") : t("shortcutEditor.change")}
                </Button>
                {r.custom ? (
                  <Button size="sm" variant="ghost" onClick={() => onReset?.(r.action)}>
                    {t("action.reset")}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/** Help for this page: search, articles, its shortcuts, the assistant, What's New and support. */
export function HelpPanel({
  articles,
  shortcuts,
  assistant = false,
  onSearch,
  onArticle,
  onAsk,
  onWhatsNew,
  onContact,
  onClose,
}: HelpPanelProps): ReactElement {
  const t = useT();
  const [question, setQuestion] = useState("");
  return (
    <aside
      aria-label={t("help.title")}
      className="flex flex-col w-(--layout-sidebar-max) max-w-full max-md:w-full rounded-card bg-bg-raised shadow-dialog"
    >
      <header className="flex items-center justify-between py-8 ps-20 pe-12 border-b border-border-subtle">
        <h2 className="m-0 text-text-13 font-semibold">{t("help.title")}</h2>
        <IconButton icon="X" label={t("action.close")} shortcut={t("key.esc")} onClick={onClose} />
      </header>
      <div className="flex flex-col gap-16 px-20 pt-16 pb-20">
        <label className={searchFieldClass}>
          <Icon name="Search" color="var(--color-text-secondary)" />
          <input
            type="search"
            aria-label={t("help.search")}
            placeholder={t("help.search")}
            onChange={(e) => onSearch?.(e.target.value)}
            className={searchInputClass}
          />
        </label>
        <section>
          <h3 className="m-0 mb-6 text-text-12 font-medium text-text-secondary">
            {t("help.forThisPage")}
          </h3>
          <ul className="flex flex-col gap-6 m-0 p-0 list-none">
            {articles.map((a) => (
              <li key={a}>
                <button
                  type="button"
                  onClick={() => onArticle?.(a)}
                  className={cx(linkClass, "p-0 border-0 bg-transparent cursor-pointer text-start")}
                >
                  {a}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="m-0 mb-6 text-text-12 font-medium text-text-secondary">
            {t("help.shortcuts")}
          </h3>
          {shortcuts.map((s) => (
            <div key={s.label} className="flex items-center justify-between min-h-control-md">
              <span>{s.label}</span>
              <Keys keys={s.keys} />
            </div>
          ))}
        </section>
        {assistant ? (
          <section>
            <h3 className="m-0 mb-6 text-text-12 font-medium text-text-secondary">
              {t("help.assistant")}
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim()) onAsk?.(question.trim());
              }}
              className={searchFieldClass}
            >
              <Icon name="Sparkles" color="var(--color-text-secondary)" />
              <input
                aria-label={t("help.ask")}
                placeholder={t("help.ask")}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className={searchInputClass}
              />
            </form>
          </section>
        ) : null}
        <div className="flex flex-wrap gap-8">
          <Button icon="Megaphone" onClick={onWhatsNew}>
            {t("help.whatsNew")}
          </Button>
          <Button icon="LifeBuoy" onClick={onContact}>
            {t("help.contact")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
