import { useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { Card } from "../Surface/Surface.tsx";
import { type AgencySlateProps } from "./Gateway.types.ts";
import { ProgressBar } from "./ProgressBar.tsx";

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
