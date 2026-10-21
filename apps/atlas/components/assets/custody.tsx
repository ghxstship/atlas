"use client";

import { assetStateKey } from "@xos/data/assets";
import { Button, Input, Select, Textarea } from "@xos/ui";
import { RefusalNotice } from "@/components/refusal-notice";
import { useState, useTransition } from "react";
import { custodyScanAction, resolveCodeAction, type ScanLookup } from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";
import { ActionDialog } from "./dialog";
import type { Option } from "./forms";

type ScanAction = "check-out" | "check-in" | "transfer";

const ACTION_KEY: Record<ScanAction, string> = {
  "check-out": "checkOut",
  "check-in": "checkIn",
  transfer: "transfer",
};

export interface CustodyPickers {
  readonly members: readonly Option[];
  readonly projects: readonly Option[];
  readonly venues: readonly Option[];
}

/**
 * One custody move through app.apply_asset_scan, the RPC Compass uses. The event id is minted when
 * the dialog opens, so a double submit or a retry after a dropped connection is applied once.
 */
export function CustodyMoveDialog({
  org,
  code,
  label,
  action,
  lot = false,
  pickers,
  defaultProjectId,
  open,
  setOpen,
  onDone,
}: {
  org: string;
  code: string;
  /** What the title calls the item; the code by default. */
  label?: string;
  action: ScanAction;
  lot?: boolean;
  pickers: CustodyPickers;
  defaultProjectId?: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  onDone?: () => void;
}) {
  const t = useAssetsCopy();
  const [eventId] = useState(() => crypto.randomUUID());
  const key = ACTION_KEY[action];
  return (
    <ActionDialog
      title={t(`custody.${key}.title`, { code: label ?? code })}
      description={t(`custody.${key}.description`)}
      submitLabel={t(`custody.${key}.submit`)}
      action={custodyScanAction}
      org={org}
      hidden={{ eventId, code, action }}
      open={open}
      setOpen={setOpen}
      {...(onDone ? { onSuccess: () => onDone() } : {})}
    >
      {action === "check-in" ? null : (
        <Select
          id="custody-member"
          name="membershipId"
          label={t("fields.membershipId")}
          value={pickers.members[0]?.value ?? ""}
          options={[...pickers.members]}
        />
      )}
      {action === "check-in" ? (
        <Select
          id="custody-venue"
          name="venueId"
          label={t("fields.checkInVenue")}
          help={t("custody.checkIn.venueHelp")}
          value=""
          options={[{ value: "", label: t("common.homeVenue") }, ...pickers.venues]}
        />
      ) : (
        <Select
          id="custody-project"
          name="projectId"
          label={t("fields.projectId")}
          help={t("custody.projectHelp")}
          value={defaultProjectId ?? ""}
          options={[{ value: "", label: t("common.keepProject") }, ...pickers.projects]}
        />
      )}
      {lot ? (
        <Input
          id="custody-quantity"
          name="quantity"
          type="number"
          min={0}
          step="any"
          required
          label={t("fields.quantity")}
        />
      ) : null}
      <Textarea id="custody-note" name="note" label={t("fields.note")} width="100%" />
    </ActionDialog>
  );
}

/**
 * The custody desk: scan with a handheld scanner (it types the code and Enter) or type a code, see
 * what it names, and move it. A code nothing carries is a NO_ANSWER refusal, never a guess.
 */
export function CustodyDesk({
  org,
  pickers,
  canMove,
}: {
  org: string;
  pickers: CustodyPickers;
  canMove: boolean;
}) {
  const t = useAssetsCopy();
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState<{ code: string; result: ScanLookup } | null>(null);
  const [moving, setMoving] = useState<ScanAction | null>(null);
  const [pending, start] = useTransition();
  const focusCode = () => document.getElementById("custody-code")?.focus();
  const find = () => {
    const typed = code.trim();
    if (!typed) return;
    start(async () => setLookup({ code: typed, result: await resolveCodeAction(org, typed) }));
  };
  const result = lookup?.result;
  const actions: readonly ScanAction[] =
    result?.kind === "unit"
      ? result.actions
      : result?.kind === "lot"
        ? (["check-out", "check-in"] as const)
        : [];
  return (
    <section aria-labelledby="custody-desk" className="flex flex-col gap-12">
      <h2 id="custody-desk" className="m-0 text-heading-14 font-semibold">
        {t("custody.desk.title")}
      </h2>
      <form
        className="flex flex-wrap items-end gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <Input
          id="custody-code"
          autoComplete="off"
          label={t("custody.desk.code")}
          help={t("custody.desk.help")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" variant="secondary" loading={pending}>
          {t("custody.desk.find")}
        </Button>
      </form>
      <div aria-live="polite">
        {result?.kind === "refused" ? (
          <RefusalNotice
            outcome="NO_ANSWER"
            title={t("custody.desk.noAnswer", { code: lookup?.code ?? "" })}
            reason={t(`errors.${result.error}`)}
            actionLabel={t("custody.desk.again")}
            onAction={() => {
              setCode("");
              setLookup(null);
              focusCode();
            }}
          />
        ) : null}
        {result?.kind === "unit" ? (
          <div className="flex flex-col gap-8 rounded-card border border-border-subtle p-12">
            <p className="m-0 text-text-14 font-medium">
              {result.unit.assetTag} · {result.unit.className}
            </p>
            <p className="m-0 text-text-13 text-text-secondary">
              {t("custody.desk.unitState", {
                state: t(`states.${assetStateKey(result.unit.state)}`),
              })}
            </p>
            {actions.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("custody.desk.cannotMove")}</p>
            ) : null}
          </div>
        ) : null}
        {result?.kind === "lot" ? (
          <div className="flex flex-col gap-8 rounded-card border border-border-subtle p-12">
            <p className="m-0 text-text-14 font-medium">{result.lot.className}</p>
            <p className="m-0 text-text-13 text-text-secondary">
              {t("custody.desk.lotOnHand", { onHand: result.lot.onHand })}
            </p>
          </div>
        ) : null}
      </div>
      {canMove && actions.length > 0 ? (
        <div className="flex flex-wrap gap-8">
          {actions.map((a) => (
            <Button
              key={a}
              variant={a === actions[0] ? "primary" : "secondary"}
              onClick={() => setMoving(a)}
            >
              {t(`actions.${ACTION_KEY[a]}`)}
            </Button>
          ))}
        </div>
      ) : null}
      {moving && lookup ? (
        <CustodyMoveDialog
          org={org}
          code={lookup.code}
          action={moving}
          lot={result?.kind === "lot"}
          pickers={pickers}
          defaultProjectId={result?.kind === "unit" ? result.unit.custodyProjectId : null}
          open
          setOpen={(next) => {
            if (!next) setMoving(null);
          }}
          onDone={() => {
            setLookup(null);
            setCode("");
            focusCode();
          }}
        />
      ) : null}
    </section>
  );
}
