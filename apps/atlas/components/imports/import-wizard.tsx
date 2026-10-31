"use client";

import { parsePasted } from "@xos/data/import-parse";
import type {
  ColumnSample,
  ImportDestinationKind,
  ImportDetail,
  ImportStatus,
  ImportSummary,
  ImportTargetField,
} from "@xos/data/imports";
import {
  DataTable,
  InlineAlert,
  Input,
  SegmentedControl,
  Select,
  StatTile,
  Stepper,
  Textarea,
} from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  cancelImportAction,
  commitImportAction,
  confirmMappingAction,
  createImportAction,
  createPastedImportAction,
  createSheetsImportAction,
  decideReviewAction,
  importSheetAction,
  undoBatchAction,
} from "@/app/[org]/import/actions";
import { ActionForm, EmptyPanel, Refresher, usePlatformT } from "@/components/platform/kit";
import type { PlatformActionState } from "@/lib/platform/state";
import { ImportAuroraSuggest, type AuroraChoice } from "./import-aurora";

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

// Destinations (P3) ----------------------------------------------------------------------------------------

/** The running orders or projects a destination target may import into, as the page listed them. */
export interface TargetDestinations {
  readonly kind: ImportDestinationKind;
  readonly options: readonly { id: string; label: string }[];
}

/** The form field that carries a destination: the action reads runOfShow or project. */
const destinationField = (kind: ImportDestinationKind) =>
  kind === "run_of_show_id" ? "runOfShow" : "project";

/** The hidden destination field of a target, or nothing for an org-wide target. */
function destinationHidden(
  destinations: Readonly<Record<string, TargetDestinations>>,
  target: string,
  picked: string | undefined,
): Record<string, string> {
  const dest = destinations[target];
  const id = picked ?? dest?.options[0]?.id;
  return dest && id ? { [destinationField(dest.kind)]: id } : {};
}

/** The destination Select of a target with one: Running order for cues, Project for guest list entries. */
function DestinationSelect({
  destinations,
  target,
  value,
  onChange,
  label,
}: {
  destinations: Readonly<Record<string, TargetDestinations>>;
  target: string;
  value: string | undefined;
  onChange: (id: string) => void;
  label?: string;
}) {
  const t = usePlatformT();
  const dest = destinations[target];
  if (!dest) return null;
  return (
    <Select
      label={
        label ??
        t(
          dest.kind === "run_of_show_id"
            ? "imports.new.destinationRun"
            : "imports.new.destinationProject",
        )
      }
      help={t("imports.new.destinationHelp")}
      value={value ?? dest.options[0]?.id ?? ""}
      options={dest.options.map((o) => ({ value: o.id, label: o.label }))}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** How many pasted rows the live preview shows. */
const PASTE_PREVIEW_ROWS = 5;

/** The pasted rows the preview shows: the header row and the first rows with text. */
function pastedPreview(text: string): string[][] {
  return parsePasted(text)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .slice(0, PASTE_PREVIEW_ROWS + 1);
}

// List and upload -------------------------------------------------------------------------------------------

export function ImportList({
  org,
  targets,
  destinations = {},
  initial,
  googleSheets = false,
  imports,
}: {
  org: string;
  targets: readonly string[];
  /** Per destination target, the running orders or projects the viewer may import into (P3). */
  destinations?: Readonly<Record<string, TargetDestinations>>;
  /** The target and destination a link preselects (?target=, ?runOfShow= or ?project=). */
  initial?: { target: string; destination: string | null } | undefined;
  /** The imports.google_sheets flag: offer a Google Sheets link next to a file (A83). */
  googleSheets?: boolean;
  imports: readonly (ImportSummary & { when: string })[];
}) {
  const t = usePlatformT();
  const router = useRouter();
  const pathname = usePathname();
  const [target, setTarget] = useState(initial?.target ?? targets[0] ?? "");
  const [source, setSource] = useState<"file" | "paste" | "sheets">("file");
  const [picked, setPicked] = useState<Record<string, string>>(() => {
    const start = initial?.destination;
    const known = initial && destinations[initial.target]?.options.some((o) => o.id === start);
    return initial && start && known ? { [initial.target]: start } : {};
  });
  const [pasted, setPasted] = useState("");
  const preview = pastedPreview(pasted);
  const open = (state: PlatformActionState) => {
    if (state.id) router.push(`${pathname}?import=${state.id}` as Route);
  };
  const hidden = { org, target, ...destinationHidden(destinations, target, picked[target]) };
  const choose = (
    <>
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
      <DestinationSelect
        destinations={destinations}
        target={target}
        value={picked[target]}
        onChange={(id) => setPicked((prev) => ({ ...prev, [target]: id }))}
      />
    </>
  );
  return (
    <div className="flex flex-col gap-24">
      <section aria-labelledby="new-import" className="flex max-w-layout-form flex-col gap-12">
        <h2 id="new-import" className="m-0 text-text-15 font-semibold">
          {t("imports.new.title")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t("imports.new.intro")}</p>
        {targets.length > 0 ? (
          <SegmentedControl
            label={t("imports.new.source")}
            value={source}
            options={[
              { value: "file", label: t("imports.new.sourceFile") },
              { value: "paste", label: t("imports.new.sourcePaste") },
              ...(googleSheets ? [{ value: "sheets", label: t("imports.new.sourceSheets") }] : []),
            ]}
            onChange={(value) =>
              setSource(value === "sheets" ? "sheets" : value === "paste" ? "paste" : "file")
            }
          />
        ) : null}
        {targets.length === 0 ? (
          <InlineAlert tone="info">{t("imports.new.noTargets")}</InlineAlert>
        ) : source === "paste" ? (
          <ActionForm
            action={createPastedImportAction}
            hidden={hidden}
            label={t("imports.new.sourcePaste")}
            submitLabel={t("imports.paste.submit")}
            disabled={preview.length < 2}
            onDone={open}
          >
            {choose}
            <Textarea
              id="import-paste"
              name="text"
              label={t("imports.paste.label")}
              help={t("imports.paste.help")}
              required
              rows={8}
              width="100%"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            {preview.length < 2 ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("imports.paste.previewEmpty")}
              </p>
            ) : (
              // The pasted cells are data, not copy; the caption still comes from the catalog.
              <div data-pseudo-exempt>
                <DataTable
                  caption={t("imports.paste.preview", { count: preview.length - 1 })}
                  label={t("imports.paste.preview", { count: preview.length - 1 })}
                  height="auto"
                  columns={(preview[0] ?? []).map((header, i) => ({
                    key: `c${i}`,
                    label: header || t("imports.map.untitled", { index: i + 1 }),
                  }))}
                  rows={preview.slice(1).map((row, r) => ({
                    id: `r${r}`,
                    ...Object.fromEntries(
                      (preview[0] ?? []).map((_h, i) => [`c${i}`, row[i] ?? ""]),
                    ),
                  }))}
                />
              </div>
            )}
          </ActionForm>
        ) : source === "sheets" && googleSheets ? (
          <ActionForm
            action={createSheetsImportAction}
            hidden={hidden}
            label={t("imports.new.sourceSheets")}
            submitLabel={t("imports.new.linkSubmit")}
            onDone={open}
          >
            {choose}
            <Input
              id="import-link"
              name="link"
              type="url"
              required
              inputMode="url"
              autoComplete="off"
              label={t("imports.new.link")}
              help={t("imports.new.linkHelp")}
              pattern="https://docs\.google\.com/spreadsheets/d/.+"
              title={t("imports.new.linkInvalid")}
            />
          </ActionForm>
        ) : (
          <ActionForm
            action={createImportAction}
            hidden={hidden}
            label={t("imports.new.title")}
            submitLabel={t("imports.new.submit")}
            onDone={open}
          >
            {choose}
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
  targets = [],
  destinations = {},
  samples = [],
  aiMapping = false,
  committedAt,
}: {
  org: string;
  detail: ImportDetail;
  fields: readonly ImportTargetField[];
  /** Targets the viewer may import into, for importing another sheet of the workbook. */
  targets?: readonly string[];
  /** Per destination target, the running orders or projects the viewer may import into (P3). */
  destinations?: Readonly<Record<string, TargetDestinations>>;
  /** The uploader's sample cells per column, while the mapping is open (P3). */
  samples?: readonly ColumnSample[];
  /** The imports.ai_mapping flag: offer Aurora's suggestions on the mapping step. */
  aiMapping?: boolean;
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
          {detail.destinationLabel ? (
            <span className="block">
              {t("imports.destinationLine", { destination: detail.destinationLabel })}
            </span>
          ) : null}
          {detail.sheetName && detail.sheets.length > 1 ? (
            <span className="block">{t("imports.sheetLine", { sheet: detail.sheetName })}</span>
          ) : null}
        </p>
      </div>
      <Stepper steps={STEP_KEYS.map((k) => t(`imports.steps.${k}`))} current={step} />
      <Refresher
        active={working}
        label={t(`imports.working.${workingKey(detail.status, detail.scanStatus, detail.source)}`)}
      />

      {detail.status === "Failed" ? (
        <InlineAlert tone="danger" title={t("imports.failed.title")}>
          {t(`imports.failed.${failedKey(detail.scanStatus, detail.failureCode, t.has)}`)}
        </InlineAlert>
      ) : null}
      {detail.status === "Canceled" ? (
        <InlineAlert tone="info">{t("imports.canceled")}</InlineAlert>
      ) : null}

      {detail.sheets.length > 1 ? (
        <SheetsSection org={org} detail={detail} targets={targets} destinations={destinations} />
      ) : null}
      {detail.status === "Mapped" && !confirmed ? (
        <MappingStep
          org={org}
          detail={detail}
          fields={fields}
          samples={samples}
          aiMapping={aiMapping}
        />
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

function workingKey(
  status: ImportStatus,
  scan: ImportDetail["scanStatus"],
  source: ImportDetail["source"],
): string {
  if (status === "Committing") return "committing";
  if (status === "Mapped") return "validating";
  if (status === "Uploaded" && scan === "Scanning") return "scanning";
  if (status === "Uploaded" && source === "Google Sheets" && scan === null) return "fetching";
  return "reading";
}

/** Why an import failed, in plain words: a virus, a file the scanner refused, a link the worker could not read, or anything else. */
function failedKey(
  scan: ImportDetail["scanStatus"],
  failure: string | null,
  has: (key: string) => boolean,
): string {
  if (scan === "Infected") return "infected";
  if (scan === "Scan Failed") return "scanFailed";
  if (failure !== null && has(`imports.failed.${failure}`)) return failure;
  return "body";
}

/** Every sheet of the workbook (A83): rows, the proposed target and the import that reads it, or a way to start one. */
function SheetsSection({
  org,
  detail,
  targets,
  destinations,
}: {
  org: string;
  detail: ImportDetail;
  targets: readonly string[];
  destinations: Readonly<Record<string, TargetDestinations>>;
}) {
  const t = usePlatformT();
  const ready = !["Uploaded", "Detected", "Failed", "Canceled"].includes(detail.status);
  return (
    <section aria-labelledby="import-sheets" className="flex flex-col gap-12">
      <h2 id="import-sheets" className="m-0 text-text-15 font-semibold">
        {t("imports.sheets.title")}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("imports.sheets.intro")}</p>
      <ul
        className="m-0 flex list-none flex-col gap-8 p-0"
        aria-label={t("imports.sheets.caption")}
      >
        {detail.sheets.map((sheet) => {
          const proposed = sheet.proposedTargetCode;
          const proposal =
            proposed === null
              ? t("imports.sheets.none")
              : sheet.proposedFromPlaybook
                ? t("imports.sheets.fromPlaybook", { target: t(`imports.targets.${proposed}`) })
                : t(`imports.targets.${proposed}`);
          const choices = targets.includes(proposed ?? "")
            ? [proposed as string, ...targets.filter((code) => code !== proposed)]
            : targets;
          return (
            <li
              key={sheet.id}
              className="flex flex-wrap items-end justify-between gap-12 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-col gap-2">
                <span className="text-text-13 font-medium">{sheet.name}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("imports.sheets.summary", { rows: sheet.dataRowCount, target: proposal })}
                </span>
              </div>
              {sheet.importId === detail.id ? (
                <span className="text-text-12 text-text-tertiary">
                  {t("imports.sheets.thisImport")}
                </span>
              ) : sheet.importId !== null ? (
                <Link
                  href={`/${org}/import?import=${sheet.importId}` as Route}
                  className="text-text-13 text-accent-text underline"
                >
                  {t("imports.sheets.open")}
                </Link>
              ) : ready && sheet.dataRowCount > 0 && choices.length > 0 ? (
                <SheetImportForm
                  org={org}
                  sheet={sheet}
                  choices={choices}
                  destinations={destinations}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Imports another sheet into a chosen target, asking for the running order or project when the target needs one. */
function SheetImportForm({
  org,
  sheet,
  choices,
  destinations,
}: {
  org: string;
  sheet: ImportDetail["sheets"][number];
  choices: readonly string[];
  destinations: Readonly<Record<string, TargetDestinations>>;
}) {
  const t = usePlatformT();
  const router = useRouter();
  const [target, setTarget] = useState(choices[0] ?? "");
  const [picked, setPicked] = useState<Record<string, string>>({});
  return (
    <ActionForm
      action={importSheetAction}
      hidden={{
        org,
        sheet: sheet.id,
        target,
        ...destinationHidden(destinations, target, picked[target]),
      }}
      label={t("imports.sheets.importLabel", { sheet: sheet.name })}
      submitLabel={t("imports.sheets.importIt")}
      submitVariant="secondary"
      inline
      onDone={(state: PlatformActionState) => {
        if (state.id) router.push(`/${org}/import?import=${state.id}` as Route);
      }}
    >
      <Select
        label={t("imports.sheets.target", { sheet: sheet.name })}
        value={target}
        options={choices.map((code) => ({
          value: code,
          label: t(`imports.targets.${code}`),
        }))}
        onChange={(e) => setTarget(e.target.value)}
      />
      <DestinationSelect
        destinations={destinations}
        target={target}
        value={picked[target]}
        onChange={(id) => setPicked((prev) => ({ ...prev, [target]: id }))}
        label={t("imports.sheets.destination", { sheet: sheet.name })}
      />
    </ActionForm>
  );
}

function MappingStep({
  org,
  detail,
  fields,
  samples,
  aiMapping,
}: {
  org: string;
  detail: ImportDetail;
  fields: readonly ImportTargetField[];
  samples: readonly ColumnSample[];
  aiMapping: boolean;
}) {
  const t = usePlatformT();
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      detail.columns.map((c) => [c.id, c.fieldName ?? c.suggestedFieldName ?? ""]),
    ),
  );
  // The columns whose current choice came from Aurora, until the person changes them.
  const [fromAurora, setFromAurora] = useState<ReadonlySet<string>>(new Set());
  const [round, setRound] = useState(0);
  const applyAurora = (picks: readonly AuroraChoice[]) => {
    setChoice((prev) => ({
      ...prev,
      ...Object.fromEntries(picks.map((p) => [p.columnId, p.field])),
    }));
    setFromAurora(new Set(picks.map((p) => p.columnId)));
    // The selects are uncontrolled: a new round remounts them with Aurora's picks.
    setRound((n) => n + 1);
  };
  const chosen = new Set(Object.values(choice).filter(Boolean));
  const missing = fields.filter((f) => f.required && !chosen.has(f.name));
  const sampleOf = (columnId: string, index: number) =>
    samples.find((x) => x.columnId === columnId && x.index === index)?.value ?? "";
  const sampleRows = [...new Set(samples.map((x) => x.index))].sort((a, b) => a - b);
  // The preview lays the sample rows out by the current choices, one column per mapped field.
  const previewColumns = detail.columns.filter((c) => choice[c.id]);
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
      {aiMapping && detail.columns.length > 0 ? (
        <ImportAuroraSuggest
          targetCode={detail.targetCode}
          columns={detail.columns}
          fields={fields}
          choice={choice}
          onApply={applyAurora}
        />
      ) : null}
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
                  key={`${c.id}-${round}`}
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
                  onChange={(e) => {
                    const value = e.target.value;
                    setChoice((prev) => ({ ...prev, [c.id]: value }));
                    setFromAurora((prev) => new Set([...prev].filter((id) => id !== c.id)));
                  }}
                />
                {fromAurora.has(c.id) ? (
                  <span className="pb-8 text-text-12 text-text-tertiary">
                    {t("imports.map.sources.Assistant")}
                  </span>
                ) : c.suggestedFieldName && c.suggestedFieldName === choice[c.id] ? (
                  <span className="pb-8 text-text-12 text-text-tertiary">
                    {c.suggestionSource
                      ? t(`imports.map.sources.${c.suggestionSource}`)
                      : t("imports.map.suggested")}
                  </span>
                ) : null}
                {sampleRows.some((n) => sampleOf(c.id, n) !== "") ? (
                  <p className="m-0 w-full text-text-12 text-text-secondary">
                    <span>{t("imports.map.samples")}</span>{" "}
                    {/* Cells of the uploaded spreadsheet: data, not copy. */}
                    <span data-pseudo-exempt>
                      {sampleRows
                        .map((n) => sampleOf(c.id, n))
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {sampleRows.length > 0 && previewColumns.length > 0 ? (
            <section aria-labelledby="map-preview" className="flex flex-col gap-8">
              <h3 id="map-preview" className="m-0 text-text-13 font-semibold">
                {t("imports.map.preview")}
              </h3>
              <p className="m-0 text-text-12 text-text-secondary">
                {t("imports.map.previewIntro")}
              </p>
              <DataTable
                caption={t("imports.map.preview")}
                label={t("imports.map.preview")}
                height="auto"
                columns={[
                  { key: "row", label: t("imports.issues.row") },
                  ...previewColumns.map((c) => ({
                    key: c.id,
                    label: t(`imports.fields.${choice[c.id] ?? ""}`),
                  })),
                ]}
                rows={sampleRows.map((n) => ({
                  id: `sample-${n}`,
                  row: t("imports.map.previewRow", { row: n }),
                  ...Object.fromEntries(previewColumns.map((c) => [c.id, sampleOf(c.id, n)])),
                }))}
              />
            </section>
          ) : null}
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
