import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Card } from "../Surface/Surface.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { type ProfileEditorProps } from "./Gateway.types.ts";
import { ProgressBar } from "./ProgressBar.tsx";

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
