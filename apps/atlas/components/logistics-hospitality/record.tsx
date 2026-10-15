import type { RecordState } from "@xos/ui";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui";
import { OperationsPeek } from "./client";
import { PropertyList, StateChip, TemplateRecord } from "./ui";

/**
 * The one record anatomy (Section 11.2) for Logistics and Hospitality entities: in the side peek
 * (`?peek={key}`) and on the full page (`&full=1`), a state of the module route until the sitemap
 * names a page for domain entities (broadcast 1, section 4).
 */
export function RecordView({
  mode,
  kindLabel,
  recordKey,
  title,
  state,
  stateLabel,
  properties,
  propertiesLabel,
  actions,
  children,
  backHref,
  backLabel,
}: {
  mode: "peek" | "full";
  kindLabel: string;
  recordKey: string;
  title: string;
  state: RecordState;
  stateLabel: string;
  properties: { label: string; value: ReactNode }[];
  propertiesLabel: string;
  actions?: ReactNode;
  children: ReactNode;
  backHref: string;
  backLabel: string;
}) {
  if (mode === "peek") {
    return (
      <OperationsPeek
        recordKey={recordKey}
        kindLabel={kindLabel}
        title={title}
        state={state}
        stateLabel={stateLabel}
        properties={properties}
      >
        {actions ? <div className="flex flex-wrap items-start gap-8">{actions}</div> : null}
        {children}
      </OperationsPeek>
    );
  }
  return (
    <TemplateRecord
      propertiesLabel={propertiesLabel}
      header={
        <header className="flex flex-col gap-8">
          <div>
            <ButtonLink href={backHref} variant="ghost" size="sm">
              {backLabel}
            </ButtonLink>
          </div>
          <p className="m-0 flex items-center gap-8 text-text-12 text-text-secondary">
            <span>{kindLabel}</span>
            <span className="font-mono">{recordKey}</span>
          </p>
          <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
          <div className="flex flex-wrap items-start gap-8">
            <StateChip state={state} label={stateLabel} />
            {actions}
          </div>
        </header>
      }
      properties={<PropertyList items={properties} />}
    >
      {children}
    </TemplateRecord>
  );
}
