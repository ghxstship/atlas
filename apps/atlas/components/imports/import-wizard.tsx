"use client";

import type {
  ImportDetail,
  ImportStatus,
  ImportSummary,
  ImportTargetField,
} from "@xos/data/imports";
import { DataTable, InlineAlert, Select, StatTile, Stepper, Textarea } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  cancelImportAction,
  commitImportAction,
  confirmMappingAction,
  createImportAction,
  decideReviewAction,
  undoBatchAction,
} from "@/app/[org]/import/actions";
import { ActionForm, EmptyPanel, Refresher, usePlatformT } from "@/components/platform/kit";
import type { PlatformActionState } from "@/lib/platform/state";

const STEP_KEYS = ["upload", "map", "review", "commit", "undo"] as const;

function stepOf(status: ImportStatus, confirmed: boolean): number {
  switch (status) {
    case "Uploaded":
    case "Detected":
      return 0;
    case "Mapped":
      return confirmed ? 2 : 1;
    case "Validated":
      return 2;
    case "Committing":
      return 3;
    default:
      return 4;
  }
}

// List and upload -------------------------------------------------------------------------------------------

export function ImportList({
  org,
  targets,
  imports,
}: {
  org: string;
  targets: readonly string[];
  imports: readonly (ImportSummary & { when: string })[];
}) {
  const t = usePlatformT();
  const router = useRouter();
  const pathname = usePathname();
  const [target, setTarget] = useState(targets[0] ?? "");
  return (
    <div className="flex flex-col gap-24">
      <section aria-labelledby="new-import" className="flex max-w-layout-form flex-col gap-12">
        <h2 id="new-import" className="m-0 text-text-15 font-semibold">
          {t("imports.new.title")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t("imports.new.intro")}</p>
        {targets.length === 0 ? (
          <InlineAlert tone="info">{t("imports.new.noTargets")}</InlineAlert>
        ) : (
          <ActionForm
            action={createImportAction}
            hidden={{ org, target }}
            label={t("imports.new.title")}
            submitLabel={t("imports.new.submit")}
            onDone={(state: PlatformActionState) => {
              if (state.id) router.push(`${pathname}?import=${state.id}` as Route);
            }}
          >
            <Select
              label={t("imports.new.target")}
              help={t("imports.new.targetHelp")}
              value={target}
              options={targets.map((code) => ({
                value: code,
                label: t(`imports.targets.${code}`),
              }))}
              onChange={(e) => setTarget(e.target.value)}
            />
            <div className="flex flex-col gap-4">
              <label htmlFor="import-file" className="text-text-13 font-medium">
                {t("imports.new.file")}
              </label>
              <input
                id="import-file"
                name="file"
                type="file"
                required
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                aria-describedby="import-file-help"
                className="text-text-13"
              />
              <p id="import-file-help" className="m-0 text-text-12 text-text-secondary">
                {t("imports.new.fileHelp")}
              </p>
            </div>
          </ActionForm>
        )}
      </section>

      <section aria-labelledby="past-imports" className="flex flex-col gap-12">
        <h2 id="past-imports" className="m-0 text-text-15 font-semibold">
          {t("imports.past.title")}
        </h2>
        {imports.length === 0 ? (
          <EmptyPanel
            icon="FileSpreadsheet"
            sentence={t("imports.past.empty")}
            actionLabel={t("imports.past.emptyAction")}
            href="#import-file"
            secondary
          />
        ) : (
          <DataTable
            caption={t("imports.past.title")}
            label={t("imports.past.title")}
            height="auto"
            columns={[
              { key: "file", label: t("imports.past.file") },
              { key: "target", label: t("imports.past.target") },
              { key: "status", label: t("imports.past.status") },
              { key: "when", label: t("imports.past.when") },
            ]}
            rows={imports.map((i) => ({
              id: i.id,
              file: i.filename,
              target: t(`imports.targets.${i.targetCode}`),
              status: t(`imports.status.${i.status}`),
              when: i.when,
            }))}
            onRowActivate={(row) =>
              router.push(`/${org}/import?import=${String(row["id"])}` as Route)
            }
          />
        )}
      </section>
    </div>
  );
}

// One import ------------------------------------------------------------------------------------------------

export function ImportWizard({
  org,
  detail,
  fields,
  committedAt,
}: {
  org: string;
  detail: ImportDetail;
  fields: readonly ImportTargetField[];
  committedAt: string | null;
}) {
  const t = usePlatformT();
  const confirmed = detail.mappingConfirmedAt !== null;
  const step = stepOf(detail.status, confirmed);
  const working =
    detail.status === "Uploaded" ||
    detail.status === "Detected" ||
    detail.status === "Committing" ||
    (detail.status === "Mapped" && confirmed);
  const cancellable = ["Uploaded", "Detected", "Mapped", "Validated"].includes(detail.status);
  return (
    <div className="flex flex-col gap-24">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <Link href={`/${org}/import` as Route} className="text-text-13 text-accent-text underline">
          {t("imports.back")}
        </Link>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("imports.fileLine", {
            file: detail.filename,
            target: t(`imports.targets.${detail.targetCode}`),
          })}
        </p>
      </div>
      <Stepper steps={STEP_KEYS.map((k) => t(`imports.steps.${k}`))} current={step} />
      <Refresher
        active={working}
        label={t(`imports.working.${workingKey(detail.status, detail.scanStatus)}`)}
      />

      {detail.status === "Failed" ? (
        <InlineAlert tone="danger" title={t("imports.failed.title")}>
          {t(`imports.failed.${failedKey(detail.scanStatus)}`)}
        </InlineAlert>
      ) : null}
      {detail.status === "Canceled" ? (
        <InlineAlert tone="info">{t("imports.canceled")}</InlineAlert>
      ) : null}

      {detail.status === "Mapped" && !confirmed ? (
        <MappingStep org={org} detail={detail} fields={fields} />
      ) : null}
      {detail.status === "Validated" ? <ReviewStep org={org} detail={detail} /> : null}
      {detail.status === "Committed" || detail.status === "Undone" ? (
        <UndoStep org={org} detail={detail} committedAt={committedAt} />
      ) : null}

      {cancellable ? (
        <ActionForm
          action={cancelImportAction}
          hidden={{ org, import: detail.id }}
          label={t("imports.cancel")}
          submitLabel={t("imports.cancel")}
          submitVariant="ghost"
        />
      ) : null}
    </div>
  );
}

function workingKey(status: ImportStatus, scan: ImportDetail["scanStatus"]): string {
  if (status === "Committing") return "committing";
  if (status === "Mapped") return "validating";
  if (status === "Uploaded" && scan === "Scanning") return "scanning";
  return "reading";
}

/** Why an import failed, in plain words: a virus, a file the scanner refused, or anything else. */
function failedKey(scan: ImportDetail["scanStatus"]): string {
  if (scan === "Infected") return "infected";
  if (scan === "Scan Failed") return "scanFailed";
  return "body";
}

function MappingStep({
  org,
  detail,
  fields,
}: {
  org: string;
  detail: ImportDetail;
  fields: readonly ImportTargetField[];
}) {
  const t = usePlatformT();
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      detail.columns.map((c) => [c.id, c.fieldName ?? c.suggestedFieldName ?? ""]),
    ),
  );
  const chosen = new Set(Object.values(choice).filter(Boolean));
  const missing = fields.filter((f) => f.required && !chosen.has(f.name));
  const hidden = Object.fromEntries([
    ["org", org],
    ["import", detail.id],
    ...Object.entries(choice).map(([id, value]) => [`column:${id}`, value]),
  ]);
  return (
    <section aria-labelledby="map-step" className="flex flex-col gap-12">
      <h2 id="map-step" className="m-0 text-text-15 font-semibold">
        {t("imports.map.title")}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("imports.map.intro")}</p>
      {detail.columns.length === 0 ? (
        <InlineAlert tone="warning">{t("imports.map.noColumns")}</InlineAlert>
      ) : (
        <ActionForm
          action={confirmMappingAction}
          hidden={hidden}
          label={t("imports.map.title")}
          submitLabel={t("imports.map.confirm")}
          disabled={missing.length > 0}
        >
          <ul
            className="m-0 flex list-none flex-col gap-8 p-0"
            aria-label={t("imports.map.columns")}
          >
            {detail.columns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-end gap-12">
                <Select
                  label={t("imports.map.column", {
                    header: c.header || t("imports.map.untitled", { index: c.index + 1 }),
                  })}
                  value={choice[c.id] ?? ""}
                  options={[
                    { value: "", label: t("imports.map.skip") },
                    ...fields.map((f) => ({
                      value: f.name,
                      label: `${t(`imports.fields.${f.name}`)}${f.required ? ` (${t("imports.map.required")})` : ""}`,
                    })),
                  ]}
                  onChange={(e) => setChoice((prev) => ({ ...prev, [c.id]: e.target.value }))}
                />
                {c.suggestedFieldName && c.suggestedFieldName === choice[c.id] ? (
                  <span className="pb-8 text-text-12 text-text-tertiary">
                    {t("imports.map.suggested")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {missing.length > 0 ? (
            <p role="status" className="m-0 text-text-13 text-danger-text">
              {t("imports.map.missing", {
                fields: missing.map((f) => t(`imports.fields.${f.name}`)).join(", "),
              })}
            </p>
          ) : null}
        </ActionForm>
      )}
    </section>
  );
}

function ReviewStep({ org, detail }: { org: string; detail: ImportDetail }) {
  const t = usePlatformT();
  const dry = detail.dryRun;
  const pending = detail.reviews.filter((r) => r.decision === "Pending");
  const header = (index: number) =>
    detail.columns.find((c) => c.index === index)?.header ?? String(index + 1);
  return (
    <div className="flex flex-col gap-24">
      <section aria-labelledby="dry-run" className="flex flex-col gap-12">
        <h2 id="dry-run" className="m-0 text-text-15 font-semibold">
          {t("imports.dryRun.title")}
        </h2>
        <div className="grid grid-cols-4 gap-16 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <StatTile label={t("imports.dryRun.creates")} value={dry?.creates ?? 0} />
          <StatTile label={t("imports.dryRun.updates")} value={dry?.updates ?? 0} />
          <StatTile label={t("imports.dryRun.merges")} value={dry?.merges ?? 0} />
          <StatTile label={t("imports.dryRun.refusals")} value={dry?.refusals ?? 0} />
        </div>
      </section>

      <section aria-labelledby="duplicates" className="flex flex-col gap-12">
        <h2 id="duplicates" className="m-0 text-text-15 font-semibold">
          {t("imports.duplicates.title")}
        </h2>
        {detail.reviews.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("imports.duplicates.none")}</p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col gap-12 p-0"
            aria-label={t("imports.duplicates.title")}
          >
            {detail.reviews.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
              >
                <p className="m-0 text-text-13">
                  {t("imports.duplicates.match", {
                    row: r.rowNumber,
                    candidate: r.candidateName ?? t("imports.duplicates.existing"),
                    percent: Math.round(r.similarity * 100),
                  })}
                </p>
                {r.decision === "Pending" ? (
                  <div className="flex flex-wrap gap-8">
                    <ActionForm
                      action={decideReviewAction}
                      hidden={{ org, review: r.id, decision: "Merged" }}
                      label={t("imports.duplicates.mergeLabel", { row: r.rowNumber })}
                      submitLabel={t("imports.duplicates.merge")}
                      inline
                    />
                    <ActionForm
                      action={decideReviewAction}
                      hidden={{ org, review: r.id, decision: "Kept Separate" }}
                      label={t("imports.duplicates.keepLabel", { row: r.rowNumber })}
                      submitLabel={t("imports.duplicates.keep")}
                      submitVariant="secondary"
                      inline
                    />
                  </div>
                ) : (
                  <p className="m-0 text-text-12 text-text-secondary">
                    {t(
                      r.decision === "Merged"
                        ? "imports.duplicates.merged"
                        : "imports.duplicates.kept",
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="row-issues" className="flex flex-col gap-12">
        <h2 id="row-issues" className="m-0 text-text-15 font-semibold">
          {t("imports.issues.title")}
        </h2>
        {detail.issues.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("imports.issues.none")}</p>
        ) : (
          <DataTable
            caption={t("imports.issues.title")}
            label={t("imports.issues.title")}
            height="auto"
            columns={[
              { key: "row", label: t("imports.issues.row"), type: "number" },
              { key: "state", label: t("imports.issues.state") },
              { key: "cells", label: t("imports.issues.cells"), wrap: true },
            ]}
            rows={detail.issues.map((i) => ({
              id: i.id,
              row: i.rowNumber,
              state: t(`imports.rowStates.${i.state}`),
              cells:
                i.cells.length > 0
                  ? i.cells
                      .map((c) =>
                        t("imports.issues.cell", {
                          column: header(c.columnIndex),
                          issue: issueText(t, c.issue),
                        }),
                      )
                      .join("; ")
                  : (i.reason ?? ""),
            }))}
          />
        )}
      </section>

      <section
        aria-labelledby="commit-step"
        className="flex flex-col gap-8 rounded-card border border-border-subtle p-16"
      >
        <h2 id="commit-step" className="m-0 text-text-15 font-semibold">
          {t("imports.commit.title")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">
          {pending.length > 0
            ? t("imports.commit.pending", { count: pending.length })
            : t("imports.commit.ready")}
        </p>
        <ActionForm
          action={commitImportAction}
          hidden={{ org, import: detail.id }}
          label={t("imports.commit.title")}
          submitLabel={t("imports.commit.submit")}
          disabled={pending.length > 0}
        />
      </section>
    </div>
  );
}

function issueText(t: ReturnType<typeof usePlatformT>, code: string): string {
  const key = `imports.issueCodes.${code}`;
  return t.has(key) ? t(key) : t("imports.issueCodes.other");
}

function UndoStep({
  org,
  detail,
  committedAt,
}: {
  org: string;
  detail: ImportDetail;
  committedAt: string | null;
}) {
  const t = usePlatformT();
  const batch = detail.batches[0];
  if (!batch) return null;
  return (
    <section aria-labelledby="undo-step" className="flex flex-col gap-12">
      <h2 id="undo-step" className="m-0 text-text-15 font-semibold">
        {batch.undoneAt ? t("imports.undo.doneTitle") : t("imports.undo.title")}
      </h2>
      <p className="m-0 text-text-13">
        {t("imports.undo.summary", { written: batch.written, when: committedAt ?? "" })}
      </p>
      {batch.undoneAt ? (
        <>
          <InlineAlert tone="success">
            {t("imports.undo.result", { reverted: batch.reverted, kept: batch.kept.length })}
          </InlineAlert>
          {batch.kept.length > 0 ? (
            <ul
              className="m-0 flex list-none flex-col gap-4 p-0"
              aria-label={t("imports.undo.keptTitle")}
            >
              {batch.kept.map((k) => (
                <li key={k.rowNumber} className="text-text-13">
                  {t("imports.undo.keptRow", { row: k.rowNumber, reason: k.reason })}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <ActionForm
          action={undoBatchAction}
          hidden={{ org, batch: batch.id }}
          label={t("imports.undo.title")}
          submitLabel={t("imports.undo.submit")}
          submitVariant="danger"
        >
          <Textarea
            id="undo-reason"
            name="reason"
            label={t("imports.undo.reason")}
            help={t("imports.undo.reasonHelp")}
            required
            maxLength={500}
            rows={2}
            width="100%"
          />
        </ActionForm>
      )}
      <Link href={`/${org}/import` as Route} className="text-text-13 text-accent-text underline">
        {t("imports.newAnother")}
      </Link>
    </section>
  );
}
