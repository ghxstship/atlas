import { useRef, useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Kbd } from "../Kbd/Kbd.tsx";
import { type QuickAddProps } from "./Editing.types.ts";
import { QuickAddChips } from "./QuickAddChips.tsx";
import { useQuickAdd } from "./useQuickAdd.ts";

/**
 * One line that turns date phrases, @person, #tag, /kind and ~scope into chips; Enter saves. With
 * `resolve`, tokens show what they resolved to and the rest stay in the title. With `onSubmit`, each
 * chip can be removed, which leaves its text in the title.
 */
export function QuickAdd({
  label,
  placeholder: hint,
  value,
  onSubmit,
  referenceDate,
  locale,
  timeZone,
  resolve,
  labels,
  id,
  disabled = false,
}: QuickAddProps): ReactElement {
  const t = useT();
  const [text, setText] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const quick = useQuickAdd({
    text,
    ...(referenceDate ? { referenceDate } : {}),
    ...(locale ? { locale } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(resolve ? { resolve } : {}),
  });
  const submit = async () => {
    if (!text.trim() || saving || disabled) return;
    setSaving(true);
    try {
      const result = await quick.finalize();
      const keep = await onSubmit?.(result);
      if (keep !== false) {
        setText("");
        quick.reset();
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-8 w-(--ui-alert) max-w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-busy={saving || undefined}
        className="flex items-center gap-8 h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring"
      >
        <Icon name="Plus" color="var(--color-text-secondary)" />
        <input
          ref={input}
          {...(id ? { id } : {})}
          aria-label={label ?? t("quickAdd.label")}
          placeholder={hint}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 min-w-0 border-0 bg-transparent outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
        />
        <Kbd>↵</Kbd>
      </form>
      {text ? (
        <QuickAddChips
          parse={quick.parse}
          {...(quick.resolutions ? { resolutions: quick.resolutions } : {})}
          choices={quick.choices}
          onChoose={quick.choose}
          {...(labels ? { labels } : {})}
          {...(onSubmit
            ? {
                onDismiss: (token) => {
                  quick.dismiss(token);
                  input.current?.focus();
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}
