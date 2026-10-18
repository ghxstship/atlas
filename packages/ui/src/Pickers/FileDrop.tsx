import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { fieldClass, helpClass, labelClass, useFieldId } from "../Field/Field.tsx";
import { type FileDropProps } from "./Pickers.types.ts";

/** Files by drag or browse, with a keyboard-reachable input and a list of what was added. */
export function FileDrop({
  label,
  hint,
  accept,
  width,
  files: initial,
  onFiles,
  id,
}: FileDropProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const inputId = useFieldId(id);
  const [over, setOver] = useState(false);
  const [files, setFiles] = useState(initial ?? []);
  const add = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFiles((current) => [
      ...current,
      ...Array.from(list, (f) => ({ name: f.name, size: f.size })),
    ]);
    onFiles?.(list);
  };
  return (
    <div
      className={fieldClass}
      style={width === undefined ? { inlineSize: "var(--ui-popover)" } : { inlineSize: width }}
    >
      {label ? <span className={labelClass}>{label}</span> : null}
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
        className={cx(
          "flex flex-col items-center gap-4 p-24 text-center rounded-card border border-dashed border-border-strong bg-bg-surface text-text-secondary cursor-pointer",
          "transition-colors duration-fast ease-standard focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring",
          over && "border-accent bg-bg-hover",
        )}
      >
        <Icon name="Upload" size={20} />
        <span>
          <strong className="text-text-primary">{t("file.drop")}</strong> {t("file.orBrowse")}
        </span>
        {hint ? <span className={helpClass}>{hint}</span> : null}
        <input
          id={inputId}
          type="file"
          multiple
          accept={accept}
          onChange={(e) => add(e.target.files)}
          className="sr-only"
        />
      </label>
      {files.length ? (
        <ul className="flex flex-col gap-4 m-0 p-0 list-none" aria-live="polite">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-8">
              <Icon name="File" size={14} />
              <span>{f.name}</span>
              <span className="ms-auto text-text-secondary tabular-nums">
                {t("file.kb", { n: fmt.number(Math.max(1, Math.round(f.size / 1024))) })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
