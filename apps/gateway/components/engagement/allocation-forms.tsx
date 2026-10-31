"use client";

import { Checkbox, Input, MoreFields, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useMemo, useState } from "react";
import { useBulk } from "@/components/bulk/use-bulk";
import { requestAllocationAction } from "@/lib/actions/allocations";
import type { FormResult } from "@/lib/actions/operations";
import { FormShell } from "./forms";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The party side's allocation forms on the Crew tab (R8): ask for an item for the pool or one person
 * (six fields: For, Item, Quantity, From, To and Note, with the time zone under More fields, Section
 * 11.10), and give several people a share of one approved pool at once through the bulk bar, with a
 * preview first and Undo after (A122). The window is typed in the project's time zone.
 */

export interface Option {
  readonly value: string;
  readonly label: string;
}

function useCrewCopy(): Translate {
  return useTranslations("gateway.engagement.crew") as unknown as Translate;
}

export function RequestItemForm(props: {
  engagementId: string;
  /** Who it is for: the pool, then each person on the roster. */
  holders: readonly Option[];
  /** What may be asked for (api_external.requestable_items), as `<kind>:<id>` values. */
  items: readonly Option[];
  timeZone: string;
}) {
  const t = useCrewCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    requestAllocationAction,
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("request.submit")}
      doneLabel={t("request.done")}
      label={t("request.title")}
    >
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="allocation-holder"
          name="holder"
          label={t("request.for")}
          value="pool"
          options={[...props.holders]}
        />
        <Select
          id="allocation-item"
          name="item"
          label={t("request.item")}
          placeholder={t("request.itemHint")}
          options={[...props.items]}
        />
        <Input
          id="allocation-quantity"
          name="quantity"
          type="number"
          min={1}
          step={1}
          defaultValue={1}
          label={t("request.quantity")}
          width={120}
        />
      </div>
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="allocation-from"
          name="neededFrom"
          type="datetime-local"
          label={t("request.from")}
        />
        <Input id="allocation-to" name="neededTo" type="datetime-local" label={t("request.to")} />
      </div>
      <Textarea
        id="allocation-note"
        name="note"
        label={t("request.note")}
        help={t("request.noteHelp")}
        maxLength={1000}
        rows={2}
      />
      <MoreFields>
        <Input
          id="allocation-zone"
          name="timeZone"
          label={t("request.timeZone")}
          help={t("request.timeZoneHelp")}
          defaultValue={props.timeZone}
        />
      </MoreFields>
    </FormShell>
  );
}

export interface AssignableEntry {
  readonly id: string;
  readonly name: string;
  /** Accepted by the reviewer and the person: only they take a share (2693). */
  readonly eligible: boolean;
  /** Each pool's current share for this person, by pool id. */
  readonly shares: Readonly<Record<string, number>>;
}

/**
 * Assign from pool: pick an approved pool and the share each selected person holds of it, select
 * people, then apply from the bulk bar. The share is what the person holds after, so a lower number
 * gives the difference back to the pool.
 */
export function AssignFromPool(props: {
  pools: readonly (Option & { readonly left: number })[];
  entries: readonly AssignableEntry[];
}) {
  const t = useCrewCopy();
  const [pool, setPool] = useState(props.pools[0]?.value ?? "");
  const [quantity, setQuantity] = useState("1");
  const rows = useMemo(
    () => props.entries.map((e) => ({ id: e.id, label: e.name, eligible: e.eligible })),
    [props.entries],
  );
  const valid = pool !== "" && /^\d{1,6}$/.test(quantity);
  const bulk = useBulk(
    valid ? "assign" : null,
    rows,
    valid ? { pool_allocation_id: pool, quantity } : undefined,
  );
  const left = props.pools.find((p) => p.value === pool)?.left ?? 0;
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="assign-pool"
          label={t("pool.assignFrom")}
          value={pool}
          options={props.pools.map((p) => ({ value: p.value, label: p.label }))}
          onChange={(e) => setPool(e.target.value)}
        />
        <Input
          id="assign-quantity"
          type="number"
          min={0}
          step={1}
          label={t("pool.sharePerPerson")}
          help={t("pool.sharePerPersonHelp", { n: left })}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          width={140}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-text-13 font-medium text-text-secondary">
          {t("pool.selectPeople")}
        </legend>
        {props.entries.map((e) => (
          <Checkbox
            key={e.id}
            label={
              e.eligible
                ? t("pool.personShare", { name: e.name, n: e.shares[pool] ?? 0 })
                : t("pool.personNotAccepted", { name: e.name })
            }
            checked={bulk.isSelected(e.id)}
            disabled={!valid}
            onChange={() => bulk.toggle(e.id)}
          />
        ))}
      </fieldset>
      {bulk.bar}
    </div>
  );
}
