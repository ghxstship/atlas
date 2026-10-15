/**
 * Native form controls styled like the @xos/ui Field (packages/ui/src/Field), renderable on the
 * server so pages can pass them into an ActionForm. Each has a visible label tied to its control and
 * optional help text tied with aria-describedby.
 */

const FIELD = "flex w-(--ui-field) max-w-full flex-col gap-4";
const LABEL = "text-text-12 font-medium text-text-secondary";
const HELP = "text-text-12 text-text-secondary";
const CONTROL =
  "h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13 text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse forced-colors:border-[CanvasText]";

interface Common {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly help?: string;
  readonly required?: boolean;
}

function Help({ id, help }: { id: string; help?: string | undefined }) {
  return help ? (
    <span id={`${id}-help`} className={HELP}>
      {help}
    </span>
  ) : null;
}

export function TextField({
  id,
  name,
  label,
  help,
  required,
  type = "text",
  defaultValue,
  maxLength,
  min,
  wide,
}: Common & {
  type?: "text" | "number" | "datetime-local" | "url";
  defaultValue?: string | number;
  maxLength?: number;
  min?: number;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "flex w-full flex-col gap-4" : FIELD}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        maxLength={maxLength}
        min={min}
        autoComplete="off"
        aria-describedby={help ? `${id}-help` : undefined}
        className={CONTROL}
      />
      <Help id={id} help={help} />
    </div>
  );
}

export function TextAreaField({
  id,
  name,
  label,
  help,
  required,
  defaultValue,
  maxLength,
}: Common & { defaultValue?: string; maxLength?: number }) {
  return (
    <div className="flex w-full flex-col gap-4">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue}
        maxLength={maxLength}
        rows={3}
        aria-describedby={help ? `${id}-help` : undefined}
        className={`${CONTROL} h-auto py-6`}
      />
      <Help id={id} help={help} />
    </div>
  );
}

export function SelectField({
  id,
  name,
  label,
  help,
  required,
  options,
  defaultValue,
}: Common & {
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
}) {
  return (
    <div className={FIELD}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue}
        aria-describedby={help ? `${id}-help` : undefined}
        className={CONTROL}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Help id={id} help={help} />
    </div>
  );
}
