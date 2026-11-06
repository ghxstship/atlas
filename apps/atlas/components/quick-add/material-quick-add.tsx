"use client";

import { Button, Input, Tag, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ActionFeedback } from "@/components/collection-kit/kit";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { useCopy } from "@/components/collection-kit/use-copy";
import { Dialog } from "@/components/lazy-ui/dialog";
import type { ActionState } from "@/lib/collection-kit/forms";
import { EQUIPMENT_LINE_LIMIT, parseEquipmentBlock } from "@/lib/quick-add/equipment";
import {
  addMaterialLinesAction,
  resolveMaterialLinesAction,
  type MaterialResolution,
  type MaterialTarget,
} from "@/lib/quick-add/material-actions";

const INITIAL: ActionState = {};

interface PreviewRow {
  readonly key: number;
  readonly item: string;
  readonly quantity: string;
  readonly assumed: boolean;
  readonly resolution: MaterialResolution | null;
}

/**
 * Paste or type an equipment list and see each line as an item and a quantity before anything is saved (B11, G-107). The
 * rows stay editable, a Matched chip says the catalogue named the item, and Add writes every line in one transaction, so
 * one bad line writes none. Keeps what was typed when the server refuses.
 */
export function MaterialQuickAdd({
  org,
  target,
  onClose,
}: {
  org: string;
  target: MaterialTarget;
  onClose: () => void;
}) {
  const t = useCopy("procurement.needs");
  const router = useRouter();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<readonly PreviewRow[] | null>(null);
  const [tooMany, setTooMany] = useState(false);
  const [resolving, start] = useTransition();
  const [state, formAction, pending] = useActionState(addMaterialLinesAction, INITIAL);
  const seen = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && seen.current !== state) {
      seen.current = state;
      router.refresh();
      onClose();
    }
  }, [state, router, onClose]);
  const preview = () => {
    const parsed = parseEquipmentBlock(text);
    if (!parsed.ok) {
      setTooMany(true);
      return;
    }
    setTooMany(false);
    start(async () => {
      const resolved = await resolveMaterialLinesAction(
        org,
        target,
        parsed.lines.map((l) => l.item),
      );
      setRows(
        parsed.lines.map((l, i) => ({
          key: l.lineNumber,
          item: l.item,
          quantity: String(l.quantity),
          assumed: l.quantityAssumed,
          resolution: resolved[i] ?? null,
        })),
      );
    });
  };
  const edit = (key: number, patch: Partial<PreviewRow>) =>
    setRows((all) => (all ?? []).map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const payload = useMemo(
    () =>
      JSON.stringify(
        (rows ?? []).map((r) => ({
          description: r.item,
          quantity: Number(r.quantity.replace(",", ".")),
          assetClassId: r.resolution?.assetClassId ?? null,
          elementId: r.resolution?.elementId ?? null,
        })),
      ),
    [rows],
  );
  return (
    <Dialog
      open
      onOpenChange={(next) => (next ? null : onClose())}
      title={t("paste.title")}
      actions={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("paste.cancel")}
          </Button>
          {rows === null ? (
            <Button
              type="button"
              variant="primary"
              disabled={text.trim() === "" || resolving}
              onClick={preview}
            >
              {t("paste.preview")}
            </Button>
          ) : (
            <Button
              type="submit"
              form="material-quick-add"
              variant="primary"
              disabled={pending || rows.length === 0}
            >
              {t("paste.add", { count: rows.length })}
            </Button>
          )}
        </>
      }
    >
      <form
        id="material-quick-add"
        action={formAction}
        onSubmit={keepInputOnSubmit(formAction)}
        className="flex flex-col gap-12"
      >
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="targetKind" value={target.kind} />
        <input
          type="hidden"
          name="targetId"
          value={target.kind === "needs" ? target.projectId : target.purchaseOrderId}
        />
        <input type="hidden" name="lines" value={payload} />
        <ActionFeedback state={state} refusals="procurement.refusals" />
        <Textarea
          id="material-paste"
          label={t("paste.label")}
          help={t("paste.help", { limit: EQUIPMENT_LINE_LIMIT })}
          rows={8}
          width="100%"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRows(null);
          }}
        />
        {tooMany ? (
          <p role="alert" className="m-0 text-text-13 text-danger-text">
            {t("paste.tooMany", { limit: EQUIPMENT_LINE_LIMIT })}
          </p>
        ) : null}
        {rows === null ? null : (
          <ul aria-label={t("paste.previewLabel")} className="m-0 flex list-none flex-col gap-8 p-0">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-wrap items-end gap-8">
                <Input
                  id={`material-qty-${r.key}`}
                  inputMode="decimal"
                  label={t("quantity")}
                  value={r.quantity}
                  {...(r.assumed ? { help: t("paste.assumed") } : {})}
                  onChange={(e) => edit(r.key, { quantity: e.target.value, assumed: false })}
                />
                <Input
                  id={`material-item-${r.key}`}
                  label={t("description")}
                  value={r.item}
                  onChange={(e) => edit(r.key, { item: e.target.value, resolution: null })}
                />
                {r.resolution ? <Tag tone="success">{t("paste.matched")}</Tag> : null}
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}
