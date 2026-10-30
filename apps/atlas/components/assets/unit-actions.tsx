"use client";

import { assetStateKey, type AssetState } from "@xos/data/assets";
import { Button, Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import {
  addIdentifierAction,
  removeIdentifierAction,
  transitionUnitAction,
  updateUnitAction,
} from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";
import { CustodyMoveDialog, type CustodyPickers } from "./custody";
import { ActionButton, ActionDialog } from "./dialog";
import { DamageForm, MaintenanceForm, type Option } from "./forms";
import type { Database } from "@xos/data/database.types";

type ScanAction = Database["app"]["Enums"]["asset_scan_action"];

export interface UnitActionsProps {
  readonly org: string;
  readonly unitId: string;
  readonly assetTag: string;
  readonly state: string;
  readonly conditionEnumId: string | null;
  readonly homeVenueId: string | null;
  readonly custodyProjectId: string | null;
  /** Next states the lifecycle allows from here, already limited to what the viewer may approve. */
  readonly nextStates: readonly Option[];
  readonly scanActions: readonly ScanAction[];
  readonly conditions: readonly Option[];
  readonly pickers: CustodyPickers;
  readonly currency: string;
  readonly today: string;
  readonly can: {
    readonly write: boolean;
    readonly custody: boolean;
    readonly maintenance: boolean;
    readonly damage: boolean;
  };
}

const ACTION_KEY: Record<ScanAction, string> = {
  "check-out": "checkOut",
  "check-in": "checkIn",
  transfer: "transfer",
};

/** The unit's actions: custody moves first, then lifecycle, maintenance, damage and edits. */
export function UnitActions(props: UnitActionsProps) {
  const t = useAssetsCopy();
  const [moving, setMoving] = useState<ScanAction | null>(null);
  const [maintaining, setMaintaining] = useState(false);
  const [damaging, setDamaging] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-8">
      {props.can.custody
        ? props.scanActions.map((a, i) => (
            <Button
              key={a}
              size="sm"
              variant={i === 0 ? "primary" : "secondary"}
              onClick={() => setMoving(a)}
            >
              {t(`actions.${ACTION_KEY[a]}`)}
            </Button>
          ))
        : null}
      {props.can.write && props.nextStates.length > 0 ? (
        <ActionButton
          label={t("units.transition.open")}
          icon="ArrowRightLeft"
          title={t("units.transition.title", { tag: props.assetTag })}
          description={t("units.transition.description", {
            state: t(`states.${assetStateKey(props.state as AssetState)}`),
          })}
          submitLabel={t("units.transition.submit")}
          action={transitionUnitAction}
          org={props.org}
          hidden={{ unitId: props.unitId, expected: props.state }}
        >
          <Select
            id="unit-next"
            name="next"
            label={t("fields.next")}
            value={props.nextStates[0]?.value ?? ""}
            options={[...props.nextStates]}
          />
          <Textarea
            id="unit-reason"
            name="reason"
            required
            width="100%"
            label={t("fields.reason")}
            help={t("units.transition.reasonHelp")}
          />
        </ActionButton>
      ) : null}
      {props.can.maintenance ? (
        <Button size="sm" variant="secondary" icon="Wrench" onClick={() => setMaintaining(true)}>
          {t("maintenance.create.open")}
        </Button>
      ) : null}
      {props.can.damage ? (
        <Button
          size="sm"
          variant="secondary"
          icon="TriangleAlert"
          onClick={() => setDamaging(true)}
        >
          {t("damage.create.open")}
        </Button>
      ) : null}
      {props.can.write ? (
        <ActionButton
          label={t("units.edit.open")}
          icon="Pencil"
          variant="ghost"
          title={t("units.edit.title", { tag: props.assetTag })}
          submitLabel={t("common.save")}
          action={updateUnitAction}
          org={props.org}
          hidden={{ unitId: props.unitId }}
        >
          <Select
            id="unit-edit-condition"
            name="conditionEnumId"
            label={t("fields.conditionEnumId")}
            value={props.conditionEnumId ?? ""}
            options={[{ value: "", label: t("common.notRecorded") }, ...props.conditions]}
          />
          <Select
            id="unit-edit-home"
            name="homeVenueId"
            label={t("fields.homeVenueId")}
            value={props.homeVenueId ?? ""}
            options={[{ value: "", label: t("common.noVenue") }, ...props.pickers.venues]}
          />
        </ActionButton>
      ) : null}
      {moving ? (
        <CustodyMoveDialog
          org={props.org}
          code={props.assetTag}
          action={moving}
          pickers={props.pickers}
          defaultProjectId={props.custodyProjectId}
          open
          setOpen={(next) => {
            if (!next) setMoving(null);
          }}
        />
      ) : null}
      {maintaining ? (
        <MaintenanceForm
          org={props.org}
          units={[]}
          unitId={props.unitId}
          currency={props.currency}
          today={props.today}
          open
          setOpen={setMaintaining}
        />
      ) : null}
      {damaging ? (
        <DamageForm
          org={props.org}
          units={[]}
          unitId={props.unitId}
          projects={props.pickers.projects}
          {...(props.custodyProjectId ? { defaultProjectId: props.custodyProjectId } : {})}
          open
          setOpen={setDamaging}
        />
      ) : null}
    </div>
  );
}

/** Adds an external identifier (serial, GTIN, MPN) to a unit. */
export function AddIdentifier({ org, unitId }: { org: string; unitId: string }) {
  const t = useAssetsCopy();
  return (
    <ActionButton
      label={t("units.identifiers.add")}
      icon="Plus"
      variant="ghost"
      title={t("units.identifiers.title")}
      description={t("units.identifiers.description")}
      submitLabel={t("units.identifiers.submit")}
      action={addIdentifierAction}
      org={org}
      hidden={{ unitId }}
    >
      <Input
        id="identifier-scheme"
        name="scheme"
        required
        label={t("fields.scheme")}
        help={t("units.identifiers.schemeHelp")}
      />
      <Input id="identifier-value" name="value" required label={t("fields.value")} />
    </ActionButton>
  );
}

/** Removes a recorded identifier after confirming. */
export function RemoveIdentifier({
  org,
  identifierId,
  label,
}: {
  org: string;
  identifierId: string;
  label: string;
}) {
  const t = useAssetsCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon="X"
        aria-label={t("units.identifiers.remove", { identifier: label })}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <ActionDialog
          title={t("units.identifiers.removeTitle", { identifier: label })}
          submitLabel={t("units.identifiers.removeSubmit")}
          action={removeIdentifierAction}
          org={org}
          hidden={{ identifierId }}
          danger
          open={open}
          setOpen={setOpen}
        />
      ) : null}
    </>
  );
}
