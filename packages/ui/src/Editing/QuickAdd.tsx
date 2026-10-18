import { useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Kbd } from "../Kbd/Kbd.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { isRecordKind } from "@xos/icons/glyphs";
import { type QuickAddProps } from "./Editing.types.ts";
import { parseQuickAdd } from "./parseQuickAdd.tsx";

/** One line that turns date phrases, @person, #tag, /kind and ~scope into chips; Enter saves. */
export function QuickAdd({
  label,
  placeholder: hint,
  value,
  onSubmit,
  referenceDate,
}: QuickAddProps): ReactElement {
  const t = useT();
  const [text, setText] = useState(value ?? "");
  const parsed = parseQuickAdd(text, referenceDate);
  return (
    <div className="flex flex-col gap-8 w-(--ui-alert) max-w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) {
            onSubmit?.(parsed);
            setText("");
          }
        }}
        className="flex items-center gap-8 h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring"
      >
        <Icon name="Plus" color="var(--color-text-secondary)" />
        <input
          aria-label={label ?? t("quickAdd.label")}
          placeholder={hint}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 min-w-0 border-0 bg-transparent outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
        />
        <Kbd>↵</Kbd>
      </form>
      {text ? (
        <div aria-live="polite" className="flex flex-wrap items-center gap-4">
          <span className="me-4 font-medium">{parsed.title || t("record.untitled")}</span>
          {parsed.tokens.map((token, i) => (
            <span key={`${token.type}-${i}`} className={chipClass}>
              <Icon name={token.icon} size={12} color="var(--color-text-secondary)" />
              {token.type === "kind" && isRecordKind(token.value) ? (
                <RecordKindGlyph kind={token.value} size={12} />
              ) : null}
              {token.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
