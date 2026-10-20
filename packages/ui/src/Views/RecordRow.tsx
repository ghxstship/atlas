import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { singleKeyShortcutsEnabled } from "../lib/preferences.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { type RecordRowProps } from "./Views.types.ts";

/** One list row that answers what now: state, key, title, chips, next date, owner and the next action. */
export function RecordRow({
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
  return (
    <div
      role="row"
      aria-selected={selected ?? undefined}
      tabIndex={-1}
      data-row
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
      <span role="gridcell" className="inline-flex">
        <StateIcon state={state} />
        <span className="sr-only">{stateLabel}</span>
      </span>
      <span role="gridcell" className="font-mono text-text-12 text-text-secondary">
        {recordKey}
      </span>
      <span role="gridcell" className="flex items-center gap-6 min-w-0">
        {kind ? (
          <RecordKindGlyph kind={kind} size={14} color="var(--color-text-secondary)" />
        ) : null}
        <span className="truncate">{title}</span>
      </span>
      <span role="gridcell" className="flex gap-4">
        {chips}
      </span>
      <span
        role="gridcell"
        className="flex items-center gap-4 text-text-12 text-text-secondary tabular-nums whitespace-nowrap"
      >
        {next ? (
          <>
            <Icon name="Calendar" size={14} />
            {next}
          </>
        ) : null}
      </span>
      <span role="gridcell">{owner ? <Avatar name={owner} /> : null}</span>
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
