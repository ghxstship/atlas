import { use, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { singleKeyShortcutsEnabled } from "../lib/preferences.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { RecordListSelection } from "./RecordList.tsx";
import { type RecordRowProps } from "./Views.types.ts";

/**
 * One list row that answers what now: state, key, title, chips, next date, owner and the next action.
 * In a selectable list a row with an `id` leads with its checkbox. The key, title and owner cells
 * carry `data-column`, and the row its `data-item` id, so a page can preview them (hover cards).
 */
export function RecordRow({
  id,
  state,
  stateLabel,
  recordKey,
  kind,
  title,
  chips,
  next,
  owner,
  actionLabel,
  actionKey,
  selected,
  onAction,
  onSelect,
  onOpen,
}: RecordRowProps): ReactElement {
  const t = useT();
  const list = use(RecordListSelection);
  const select = list && id !== undefined ? list : null;
  const isSelected = selected ?? (select && id !== undefined ? select.isSelected(id) : undefined);
  return (
    <div
      role="row"
      aria-selected={isSelected ?? undefined}
      tabIndex={-1}
      data-row
      data-item={id}
      data-selectable={select ? "" : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key.toLowerCase() === "x" && onSelect && singleKeyShortcutsEnabled()) {
          e.preventDefault();
          onSelect();
        } else if (e.key === "Enter" && onOpen) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cx(
        "xos-rrow border-b border-border-subtle last:border-b-0 outline-none",
        "hover:bg-bg-hover focus-visible:bg-bg-hover aria-selected:bg-bg-hover",
        "focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-inset focus-visible:ring-focus-ring",
      )}
    >
      {select && id !== undefined ? (
        <span role="gridcell" className="xos-rrow-select inline-flex">
          <input
            type="checkbox"
            tabIndex={-1}
            className="xos-check-input"
            aria-label={t("table.selectRow", { row: title })}
            checked={isSelected === true}
            onClick={(e) => {
              e.stopPropagation();
              select.toggle(id, e.shiftKey);
            }}
            onChange={() => undefined}
          />
        </span>
      ) : null}
      <span role="gridcell" className="xos-rrow-state inline-flex">
        <StateIcon state={state} />
        <span className="sr-only">{stateLabel}</span>
      </span>
      <span
        role="gridcell"
        data-column="key"
        className="xos-rrow-key font-mono text-text-12 text-text-secondary"
      >
        {recordKey}
      </span>
      <span
        role="gridcell"
        data-column="title"
        className="xos-rrow-title flex items-center gap-6 min-w-0"
      >
        {kind ? (
          <RecordKindGlyph kind={kind} size={14} color="var(--color-text-secondary)" />
        ) : null}
        <span className="truncate" title={title}>
          {title}
        </span>
      </span>
      <span role="gridcell" className="xos-rrow-chips flex gap-4">
        {chips}
      </span>
      {/* The next date has a column wide enough for a date and time; a longer translation ellipsizes
          with the full text as its title instead of running under the owner (A59-008). */}
      <span
        role="gridcell"
        className="xos-rrow-next flex items-center gap-4 min-w-0 text-text-12 text-text-secondary tabular-nums whitespace-nowrap"
      >
        {next ? (
          <>
            <Icon name="Calendar" size={14} />
            <span className="truncate" title={next}>
              {next}
            </span>
          </>
        ) : null}
      </span>
      <span role="gridcell" data-column="owner" className="xos-rrow-owner">
        {owner ? <Avatar name={owner} /> : null}
      </span>
      <span role="gridcell" className="xos-rrow-action flex justify-end">
        {actionLabel ? (
          <Button size="sm" onClick={onAction} {...(actionKey ? { shortcut: actionKey } : {})}>
            {actionLabel}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
