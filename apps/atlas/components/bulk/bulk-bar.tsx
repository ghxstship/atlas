"use client";

import type { BulkOutcome, BulkRow, BulkValue } from "@xos/data/bulk";
import {
  BulkActionBar,
  Button,
  Dialog,
  InlineAlert,
  Input,
  Select,
  Toast,
  ToastRegion,
  UndoToast,
} from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { bulkUpdateAction, type BulkActionResult } from "@/lib/bulk/actions";
import type { BulkConfig, BulkField, BulkRowRef } from "./types";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Choice values travel through a native select as JSON, so null and strings stay apart. */
const encode = (value: BulkValue) => JSON.stringify(value);
const decode = (raw: string): BulkValue => JSON.parse(raw) as BulkValue;

interface Done {
  readonly message: string;
  readonly inverse: readonly BulkRow[];
}

/**
 * The bulk action bar and its edit dialog (Section 11.7), loaded with the first selection. A change
 * is previewed first: how many rows it changes, how many already hold the value, and every row that
 * cannot change with the reason the database gave. Applying runs in one transaction, so a refused
 * row means nothing changed. A committed change offers Undo for 8 seconds, which sends the inverse
 * rows back through the same RPC and is itself refused for any row someone changed since.
 */
export function BulkBar({
  config,
  rows,
  selected,
  onClear,
}: {
  config: BulkConfig;
  rows: readonly BulkRowRef[];
  selected: ReadonlySet<string>;
  onClear: () => void;
}) {
  const t = useTranslations("collab.bulk") as unknown as Translate;
  const router = useRouter();
  const [field, setField] = useState<BulkField | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const labels = new Map(rows.map((r) => [r.id, r.label]));

  const undo = async (inverse: readonly BulkRow[]) => {
    const result = await bulkUpdateAction({
      org: config.org,
      resource: config.resource,
      rows: inverse.map((r) => ({
        id: r.id,
        set: { ...r.set },
        ...(r.expect ? { expect: { ...r.expect } } : {}),
      })),
      preview: false,
    });
    if (result.ok && result.outcome.committed) {
      setNotice(t("undone"));
      router.refresh();
      return;
    }
    const first = result.ok ? result.outcome.refused[0] : undefined;
    setNotice(
      t("undoRefused", {
        message: first ? first.message : result.ok ? "" : (result.message ?? t("failed")),
      }),
    );
  };

  return (
    <>
      {selected.size > 0 ? (
        <div className="pointer-events-none sticky bottom-16 z-sticky flex justify-center print:hidden">
          <div className="pointer-events-auto">
            <BulkActionBar
              count={selected.size}
              announce={false}
              actions={config.fields.slice(0, 4).map((f) => ({
                label: t("change", { field: f.label }),
                icon: "PencilLine",
                onSelect: () => setField(f),
              }))}
              onClear={onClear}
            />
          </div>
        </div>
      ) : null}
      {field ? (
        <BulkDialog
          config={config}
          field={field}
          ids={[...selected]}
          labels={labels}
          t={t}
          onClose={() => setField(null)}
          onDone={(outcome) => {
            setField(null);
            onClear();
            setNotice(null);
            setDone({ message: t("done", { count: outcome.changed }), inverse: outcome.inverse });
          }}
        />
      ) : null}
      <ToastRegion label={t("notifications")}>
        {notice ? (
          <Toast message={notice} actionLabel={t("dismiss")} onAction={() => setNotice(null)} />
        ) : null}
        {done ? (
          <UndoToast
            key={done.message + done.inverse.length}
            message={done.message}
            onUndo={() => {
              const inverse = done.inverse;
              setDone(null);
              void undo(inverse);
            }}
            onExpire={() => setDone(null)}
          />
        ) : null}
      </ToastRegion>
    </>
  );
}

function BulkDialog({
  config,
  field,
  ids,
  labels,
  t,
  onClose,
  onDone,
}: {
  config: BulkConfig;
  field: BulkField;
  ids: readonly string[];
  labels: ReadonlyMap<string, string>;
  t: Translate;
  onClose: () => void;
  onDone: (outcome: BulkOutcome) => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(encode(field.options[0]?.value ?? null));
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (asPreview: boolean) =>
    start(async () => {
      const set = { [field.key]: decode(value) };
      const result: BulkActionResult = await bulkUpdateAction({
        org: config.org,
        resource: config.resource,
        rows: ids.map((id) => ({ id, set })),
        preview: asPreview,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.message ?? t("failed"));
        return;
      }
      setError(null);
      if (!asPreview && result.outcome.committed) {
        router.refresh();
        onDone(result.outcome);
        return;
      }
      setPreview(result.outcome);
    });

  const count = ids.length;
  const blocked = preview !== null && preview.refused.length > 0;
  const nothing = preview !== null && !blocked && preview.changed === 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t("title", { field: field.label, count })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          {preview === null || blocked || nothing ? (
            <Button loading={pending} onClick={() => run(true)}>
              {t("preview")}
            </Button>
          ) : (
            <Button variant="primary" loading={pending} onClick={() => run(false)}>
              {t("apply", { count: preview.changed })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-12 text-text-primary">
        <Select
          id="bulk-value"
          label={t("value", { field: field.label })}
          value={value}
          options={field.options.map((o) => ({ value: encode(o.value), label: o.label }))}
          onChange={(e) => {
            setValue(e.target.value);
            setPreview(null);
          }}
        />
        {field.reason ? (
          <Input
            id="bulk-reason"
            label={t("reason")}
            help={t("reasonHelp")}
            width="100%"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setPreview(null);
            }}
          />
        ) : null}
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {preview && !blocked ? (
          <div role="status" className="flex flex-col gap-4 text-text-13">
            {nothing ? (
              <p className="m-0">{t("nothing")}</p>
            ) : (
              <>
                <p className="m-0 font-medium">{t("changed", { count: preview.changed })}</p>
                {preview.unchanged > 0 ? (
                  <p className="m-0 text-text-secondary">
                    {t("unchanged", { count: preview.unchanged })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {preview && blocked ? (
          <InlineAlert tone="warning" title={t("refusedTitle", { count: preview.refused.length })}>
            <p className="m-0 mb-6">{t("refusedBody")}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {preview.refused.map((r, i) => (
                <li key={r.id ?? i}>
                  {t("refusedRow", {
                    row: (r.id ? labels.get(r.id) : undefined) ?? t("someRow"),
                    message: r.message,
                  })}
                </li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
      </div>
    </Dialog>
  );
}
