"use client";

import { Button, Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  countLotAction,
  createClassAction,
  createLotAction,
  createUnitAction,
  recordMaintenanceAction,
  reportDamageAction,
  searchElementsAction,
} from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";
import { ActionDialog, useCreateDialog } from "./dialog";

/** A value and label for a picker, built by the page from rows the viewer may read. */
export interface Option {
  readonly value: string;
  readonly label: string;
}

const none = (label: string): Option => ({ value: "", label });

// Classes ------------------------------------------------------------------------------------------

/** New asset class: find the canon element it is, then name it. */
export function NewClassForm({ org }: { org: string }) {
  const t = useAssetsCopy();
  const [open, setOpen] = useCreateDialog();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Option[] | null>(null);
  const [elementId, setElementId] = useState("");
  const [name, setName] = useState("");
  const [searching, startSearch] = useTransition();
  const find = () =>
    startSearch(async () => {
      const found = await searchElementsAction(query);
      const options = found.map((e) => ({
        value: e.elementId,
        label: `${e.elementId} · ${e.item}`,
      }));
      setResults(options);
      const first = found[0];
      setElementId(first?.elementId ?? "");
      if (first && !name) setName(first.item);
    });
  return (
    <ActionDialog
      title={t("classes.create.title")}
      description={t("classes.create.description")}
      submitLabel={t("classes.create.submit")}
      action={createClassAction}
      org={org}
      open={open}
      setOpen={setOpen}
    >
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id="class-element-search"
          type="search"
          label={t("classes.create.search")}
          help={t("classes.create.searchHelp")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              find();
            }
          }}
        />
        <Button type="button" variant="secondary" loading={searching} onClick={find}>
          {t("classes.create.find")}
        </Button>
      </div>
      {results !== null && results.length === 0 ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("classes.create.noElements")}
        </p>
      ) : null}
      {results && results.length > 0 ? (
        <Select
          id="class-element"
          name="elementId"
          label={t("fields.elementId")}
          value={elementId}
          options={results}
          onChange={(e) => setElementId(e.target.value)}
        />
      ) : null}
      <Input
        id="class-name"
        name="name"
        required
        width="100%"
        label={t("fields.name")}
        help={t("classes.create.nameHelp")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </ActionDialog>
  );
}

// Units --------------------------------------------------------------------------------------------

export function NewUnitForm({
  org,
  classes,
  conditions,
  venues,
  defaultClassId,
}: {
  org: string;
  classes: readonly Option[];
  conditions: readonly Option[];
  venues: readonly Option[];
  defaultClassId?: string;
}) {
  const t = useAssetsCopy();
  const router = useRouter();
  const [open, setOpen] = useCreateDialog();
  return (
    <ActionDialog
      title={t("units.create.title")}
      description={t("units.create.description")}
      submitLabel={t("units.create.submit")}
      action={createUnitAction}
      org={org}
      open={open}
      setOpen={setOpen}
      onSuccess={(state) => {
        if (state.assetTag) {
          router.replace(
            `/${org}/assets/units?peek=${encodeURIComponent(state.assetTag)}` as Route,
          );
        }
      }}
    >
      <Select
        id="unit-class"
        name="classId"
        label={t("fields.classId")}
        value={defaultClassId ?? classes[0]?.value ?? ""}
        options={[...classes]}
      />
      <Input
        id="unit-tag"
        name="assetTag"
        required
        autoComplete="off"
        label={t("fields.assetTag")}
        help={t("units.create.tagHelp")}
      />
      <Select
        id="unit-condition"
        name="conditionEnumId"
        label={t("fields.conditionEnumId")}
        value=""
        options={[none(t("common.notRecorded")), ...conditions]}
      />
      <Select
        id="unit-home"
        name="homeVenueId"
        label={t("fields.homeVenueId")}
        value=""
        options={[none(t("common.noVenue")), ...venues]}
      />
    </ActionDialog>
  );
}

// Lots ---------------------------------------------------------------------------------------------

export function NewLotForm({
  org,
  classes,
  venues,
}: {
  org: string;
  classes: readonly Option[];
  venues: readonly Option[];
}) {
  const t = useAssetsCopy();
  const [open, setOpen] = useCreateDialog();
  return (
    <ActionDialog
      title={t("lots.create.title")}
      description={t("lots.create.description")}
      submitLabel={t("lots.create.submit")}
      action={createLotAction}
      org={org}
      open={open}
      setOpen={setOpen}
    >
      <Select
        id="lot-class"
        name="classId"
        label={t("fields.classId")}
        value={classes[0]?.value ?? ""}
        options={[...classes]}
      />
      <Select
        id="lot-venue"
        name="venueId"
        label={t("fields.venueId")}
        value={venues[0]?.value ?? ""}
        options={[...venues]}
      />
      <Input
        id="lot-quantity"
        name="quantity"
        type="number"
        min={0}
        step="any"
        required
        label={t("fields.quantity")}
        help={t("lots.create.quantityHelp")}
      />
    </ActionDialog>
  );
}

export function CountLotForm({
  org,
  lotId,
  onHand,
  open,
  setOpen,
}: {
  org: string;
  lotId: string;
  onHand: number;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const t = useAssetsCopy();
  return (
    <ActionDialog
      title={t("lots.count.title")}
      description={t("lots.count.description", { onHand })}
      submitLabel={t("lots.count.submit")}
      action={countLotAction}
      org={org}
      hidden={{ lotId }}
      open={open}
      setOpen={setOpen}
    >
      <Input
        id="lot-counted"
        name="counted"
        type="number"
        min={0}
        step="any"
        required
        defaultValue={String(onHand)}
        label={t("fields.counted")}
      />
      <Textarea id="lot-count-note" name="note" label={t("fields.note")} width="100%" />
    </ActionDialog>
  );
}

// Maintenance and damage ---------------------------------------------------------------------------

export function MaintenanceForm({
  org,
  units,
  currency,
  today,
  unitId,
  open: controlledOpen,
  setOpen: controlledSetOpen,
}: {
  org: string;
  units: readonly Option[];
  currency: string;
  today: string;
  unitId?: string;
  open?: boolean;
  setOpen?: (open: boolean) => void;
}) {
  const t = useAssetsCopy();
  const [sharedOpen, sharedSetOpen] = useCreateDialog();
  const open = controlledOpen ?? sharedOpen;
  const setOpen = controlledSetOpen ?? sharedSetOpen;
  return (
    <ActionDialog
      title={t("maintenance.create.title")}
      description={t("maintenance.create.description")}
      submitLabel={t("maintenance.create.submit")}
      action={recordMaintenanceAction}
      org={org}
      hidden={{ currencyCode: currency, ...(unitId ? { unitId } : {}) }}
      open={open}
      setOpen={setOpen}
    >
      {unitId ? null : (
        <Select
          id="maintenance-unit"
          name="unitId"
          label={t("fields.unitId")}
          value={units[0]?.value ?? ""}
          options={[...units]}
        />
      )}
      <Input
        id="maintenance-date"
        name="performedOn"
        type="date"
        required
        defaultValue={today}
        label={t("fields.performedOn")}
      />
      <Textarea
        id="maintenance-description"
        name="description"
        required
        width="100%"
        label={t("fields.description")}
      />
      <Input
        id="maintenance-cost"
        name="cost"
        inputMode="decimal"
        label={t("fields.cost", { currency })}
        help={t("maintenance.create.costHelp")}
      />
    </ActionDialog>
  );
}

export function DamageForm({
  org,
  units,
  projects,
  unitId,
  defaultProjectId,
  open: controlledOpen,
  setOpen: controlledSetOpen,
}: {
  org: string;
  units: readonly Option[];
  projects: readonly Option[];
  unitId?: string;
  defaultProjectId?: string;
  open?: boolean;
  setOpen?: (open: boolean) => void;
}) {
  const t = useAssetsCopy();
  const [sharedOpen, sharedSetOpen] = useCreateDialog();
  const open = controlledOpen ?? sharedOpen;
  const setOpen = controlledSetOpen ?? sharedSetOpen;
  return (
    <ActionDialog
      title={t("damage.create.title")}
      description={t("damage.create.description")}
      submitLabel={t("damage.create.submit")}
      action={reportDamageAction}
      org={org}
      hidden={unitId ? { unitId } : {}}
      open={open}
      setOpen={setOpen}
    >
      {unitId ? null : (
        <Select
          id="damage-unit"
          name="unitId"
          label={t("fields.unitId")}
          value={units[0]?.value ?? ""}
          options={[...units]}
        />
      )}
      <Select
        id="damage-project"
        name="projectId"
        label={t("fields.projectId")}
        value={defaultProjectId ?? ""}
        options={[none(t("common.noProject")), ...projects]}
      />
      <Textarea
        id="damage-description"
        name="description"
        required
        width="100%"
        label={t("fields.description")}
        help={t("damage.create.descriptionHelp")}
      />
    </ActionDialog>
  );
}
