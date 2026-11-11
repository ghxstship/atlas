"use client";

import type { PlaceSpec } from "@xos/data/places";
import { Input, Select, Textarea } from "@xos/ui";
import { savePlaceSpecAction } from "@/app/[org]/places/plan-actions";
import { ActionForm, useCopy } from "../kit/form";

type NumberField =
  | "housePowerAmps"
  | "housePowerVoltage"
  | "loadingDockCount"
  | "dockHeightIn"
  | "dockDoorWidthIn"
  | "dockDoorHeightIn"
  | "lengthFt"
  | "widthFt"
  | "clearHeightFt"
  | "floorLoadPsf"
  | "occupantLoad"
  | "riggingPointCount"
  | "riggingPointLoadLb"
  | "riggingTotalLoadLb"
  | "internetBandwidthMbps";
type YesNoField = "forkliftOnSite" | "wifiAvailable" | "hardlineAvailable";
type TextField = "powerConnections" | "dockNotes" | "riggingNotes" | "networkNotes";

type Field =
  | { readonly kind: "number"; readonly name: NumberField; readonly whole?: boolean }
  | { readonly kind: "yesno"; readonly name: YesNoField }
  | { readonly kind: "text"; readonly name: TextField; readonly max: number }
  | { readonly kind: "phase" };

const GROUPS: readonly { readonly id: string; readonly fields: readonly Field[] }[] = [
  {
    id: "power",
    fields: [
      { kind: "number", name: "housePowerAmps", whole: true },
      { kind: "number", name: "housePowerVoltage", whole: true },
      { kind: "phase" },
      { kind: "text", name: "powerConnections", max: 300 },
    ],
  },
  {
    id: "dock",
    fields: [
      { kind: "number", name: "loadingDockCount", whole: true },
      { kind: "number", name: "dockHeightIn" },
      { kind: "number", name: "dockDoorWidthIn" },
      { kind: "number", name: "dockDoorHeightIn" },
      { kind: "yesno", name: "forkliftOnSite" },
      { kind: "text", name: "dockNotes", max: 500 },
    ],
  },
  {
    id: "dimensions",
    fields: [
      { kind: "number", name: "lengthFt" },
      { kind: "number", name: "widthFt" },
      { kind: "number", name: "clearHeightFt" },
      { kind: "number", name: "floorLoadPsf" },
      { kind: "number", name: "occupantLoad", whole: true },
    ],
  },
  {
    id: "rigging",
    fields: [
      { kind: "number", name: "riggingPointCount", whole: true },
      { kind: "number", name: "riggingPointLoadLb" },
      { kind: "number", name: "riggingTotalLoadLb" },
      { kind: "text", name: "riggingNotes", max: 500 },
    ],
  },
  {
    id: "network",
    fields: [
      { kind: "yesno", name: "wifiAvailable" },
      { kind: "number", name: "internetBandwidthMbps" },
      { kind: "yesno", name: "hardlineAvailable" },
      { kind: "text", name: "networkNotes", max: 500 },
    ],
  },
];

/**
 * The technical specs of a venue or a space (G-92, ADR 0140 D8), grouped as Power, Dock and access, Dimensions,
 * Rigging and Network. A blank field is not recorded and never passes a check (Section 3.7). There is no password
 * field: the network help says where credentials go. A space has no occupant load; it keeps its capacity.
 */
export function PlaceSpecForm({
  org,
  spec,
  documents,
  canWrite,
}: {
  org: string;
  spec: PlaceSpec;
  /** The venue's capability documents that can document the spec. */
  documents: readonly { readonly id: string; readonly title: string }[];
  canWrite: boolean;
}) {
  const t = useCopy("places");
  const forSpace = spec.spaceId !== null;
  const id = (name: string) => `spec-${spec.spaceId ?? spec.venueId}-${name}`;
  const value = (name: keyof PlaceSpec) => {
    const v = spec[name];
    return v === null || v === undefined ? "" : String(v);
  };
  const yesNo = (name: YesNoField) =>
    spec[name] === true ? "yes" : spec[name] === false ? "no" : "";
  const body = (error: (field: string) => string) =>
    GROUPS.map((group) => (
      <fieldset key={group.id} className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-text-14 font-semibold">{t(`specs.groups.${group.id}`)}</legend>
        {group.id === "network" ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("specs.networkHelp")}</p>
        ) : null}
        <div className="flex flex-wrap gap-12">
          {group.fields
            .filter((f) => !(forSpace && f.kind === "number" && f.name === "occupantLoad"))
            .map((f) => {
              if (f.kind === "phase") {
                return (
                  <Select
                    key="phase"
                    id={id("phase")}
                    name="housePowerPhase"
                    label={t("specs.fields.housePowerPhase")}
                    value={value("housePowerPhase")}
                    disabled={!canWrite}
                    options={[
                      { value: "", label: t("kit.notRecorded") },
                      { value: "1", label: t("specs.phase.1") },
                      { value: "3", label: t("specs.phase.3") },
                    ]}
                  />
                );
              }
              if (f.kind === "yesno") {
                return (
                  <Select
                    key={f.name}
                    id={id(f.name)}
                    name={f.name}
                    label={t(`specs.fields.${f.name}`)}
                    value={yesNo(f.name)}
                    disabled={!canWrite}
                    options={[
                      { value: "", label: t("kit.notRecorded") },
                      { value: "yes", label: t("specs.yes") },
                      { value: "no", label: t("specs.no") },
                    ]}
                  />
                );
              }
              if (f.kind === "text") {
                return (
                  <Textarea
                    key={f.name}
                    id={id(f.name)}
                    name={f.name}
                    label={t(`specs.fields.${f.name}`)}
                    defaultValue={value(f.name)}
                    maxLength={f.max}
                    width="100%"
                    disabled={!canWrite}
                    error={error(f.name)}
                  />
                );
              }
              return (
                <Input
                  key={f.name}
                  id={id(f.name)}
                  name={f.name}
                  type="number"
                  min="0"
                  step={f.whole ? "1" : "any"}
                  inputMode={f.whole ? "numeric" : "decimal"}
                  label={t(`specs.fields.${f.name}`)}
                  defaultValue={value(f.name)}
                  disabled={!canWrite}
                  error={error(f.name)}
                />
              );
            })}
        </div>
      </fieldset>
    ));
  const documentSelect = (
    <Select
      id={id("document")}
      name="specDocumentId"
      label={t("specs.documentedBy")}
      help={t("specs.documentedByHelp")}
      value={value("specDocumentId")}
      disabled={!canWrite}
      options={[
        { value: "", label: t("specs.noDocument") },
        ...documents.map((d) => ({ value: d.id, label: d.title })),
      ]}
    />
  );
  return (
    <section aria-labelledby={id("heading")} className="flex flex-col gap-12">
      <h3 id={id("heading")} className="m-0 text-text-16 font-semibold">
        {t("specs.title")}
      </h3>
      {canWrite ? (
        <ActionForm
          action={savePlaceSpecAction}
          org={org}
          hidden={{ venueId: spec.venueId, ...(spec.spaceId ? { spaceId: spec.spaceId } : {}) }}
          submitLabel={t("specs.save")}
          successMessage={t("kit.saved")}
        >
          {(error) => (
            <>
              {body(error)}
              {documentSelect}
            </>
          )}
        </ActionForm>
      ) : (
        <div className="flex flex-col gap-12">
          {body(() => "")}
          {documentSelect}
        </div>
      )}
    </section>
  );
}
