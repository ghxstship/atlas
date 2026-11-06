"use client";

import { Checkbox, IconButton, Input, MultiSelect, Select } from "@xos/ui";
import { useActionState, useId, useState } from "react";
import { addSectionChoiceAction, removeSectionChoiceAction, type AdvancingState } from "./actions";
import { useCopy } from "./use-copy";

/**
 * The kind-specific fields of an advance section (R9, migration 2710), loaded on demand by the
 * packet builder only when a section's kind is not Text, so the packet page keeps its weight:
 * the window kind of a Schedule Window, the most files, windows or lines an answer may hold, per
 * person for item and credential requests, and the asset classes or credential categories a
 * request section offers. A sent packet's sections are fixed (advance_packet_sections_fixed).
 */

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

const WINDOW_KINDS = [
  "Load In",
  "Load Out",
  "Arrival",
  "Soundcheck",
  "Activation Setup",
  "Activation Strike",
] as const;
const LIMITS: Readonly<Record<string, number>> = {
  File: 10,
  "Schedule Window": 5,
  "Item Request": 50,
  "Credential Request": 50,
};

const key = (v: string) =>
  v
    .split(" ")
    .map((w, i) => (i === 0 ? w.toLowerCase() : w))
    .join("");

/** Fields of the Add section form for a kind other than Text. */
export function SectionKindFields({
  kind,
  assetClasses,
  credentialCategories,
}: {
  kind: string;
  assetClasses: readonly ChoiceOption[];
  credentialCategories: readonly ChoiceOption[];
}) {
  const t = useCopy("advancing.sections.kind");
  const id = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const limit = LIMITS[kind];
  const options =
    kind === "Item Request"
      ? assetClasses
      : kind === "Credential Request"
        ? credentialCategories
        : [];
  if (limit === undefined) return null;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end gap-8">
        {kind === "Schedule Window" ? (
          <Select
            id={`${id}-window`}
            name="windowKind"
            label={t("windowKind")}
            value="Load In"
            options={WINDOW_KINDS.map((w) => ({ value: w, label: t(`windowKinds.${key(w)}`) }))}
          />
        ) : null}
        <Input
          id={`${id}-max`}
          name="maxLines"
          type="number"
          min={1}
          max={limit}
          step={1}
          defaultValue={kind === "File" ? 3 : kind === "Schedule Window" ? 2 : 10}
          label={
            kind === "File"
              ? t("maxFiles")
              : kind === "Schedule Window"
                ? t("maxWindows")
                : t("maxLines")
          }
          help={t("maxHelp", { n: limit })}
          width={140}
        />
      </div>
      {kind === "Item Request" || kind === "Credential Request" ? (
        <>
          <Checkbox name="perPerson" label={t("perPerson")} />
          {options.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {kind === "Item Request" ? t("noClasses") : t("noCategories")}
            </p>
          ) : (
            <MultiSelect
              id={`${id}-choices`}
              label={kind === "Item Request" ? t("items") : t("categories")}
              help={kind === "Item Request" ? t("itemsHelp") : t("categoriesHelp")}
              options={[...options]}
              value={picked}
              onChange={setPicked}
            />
          )}
          {picked.map((v) => (
            <input key={v} type="hidden" name="choice" value={v} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/** The choices of a draft request section, each removable, with one more to add. */
export function SectionChoicesEditor({
  org,
  sectionId,
  kind,
  choices,
  options,
  editable,
}: {
  org: string;
  sectionId: string;
  kind: string;
  choices: readonly { id: string; name: string; value: string }[];
  options: readonly ChoiceOption[];
  editable: boolean;
}) {
  const t = useCopy("advancing.sections.kind");
  const [, remove] = useActionState<AdvancingState, FormData>(removeSectionChoiceAction, {});
  const [added, add, pending] = useActionState<AdvancingState, FormData>(
    addSectionChoiceAction,
    {},
  );
  const id = useId();
  const taken = new Set(choices.map((c) => c.value));
  const left = options.filter((o) => !taken.has(o.value));
  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label={kind === "Item Request" ? t("items") : t("categories")}
        className="m-0 flex list-none flex-wrap gap-4 p-0"
      >
        {choices.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2 rounded-control bg-bg-surface px-8 py-2 text-text-12"
          >
            {c.name}
            {editable ? (
              <form action={remove}>
                <input type="hidden" name="org" value={org} />
                <input type="hidden" name="choiceId" value={c.id} />
                <IconButton type="submit" icon="X" label={t("removeChoice", { name: c.name })} />
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {editable && left.length > 0 ? (
        <form action={add} className="flex flex-wrap items-end gap-8">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="sectionId" value={sectionId} />
          <Select
            id={`${id}-add`}
            name="choice"
            label={t("addChoice")}
            options={[...left]}
            value={left[0]?.value ?? ""}
          />
          <button
            type="submit"
            disabled={pending}
            className="min-h-touch-min text-text-13 text-accent-text hover:underline"
          >
            {t("add")}
          </button>
          {added.error ? (
            <span className="text-text-12 text-danger-text">{t("addFailed")}</span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
