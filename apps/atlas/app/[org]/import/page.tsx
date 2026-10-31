import {
  getImport,
  importColumnSamples,
  importFlags,
  listImportDestinations,
  listImports,
  listImportTargets,
  type ImportDestination,
  type ImportTarget,
} from "@xos/data/imports";
import { ImportList, ImportWizard } from "@/components/imports/import-wizard";
import { ErrorPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/client/page-header";
import { requireNode } from "@/lib/shell/require-node";
import { getFormatters } from "@/lib/platform/format";

/**
 * The import wizard (Section 4.6.2): upload a spreadsheet or paste a Google Sheets link, import each sheet of a
 * workbook into its own target, confirm every column mapping (with suggestions from saved mappings, the Playbook
 * column map, the column names and, when the org has AI on, Aurora), review the row issues and fuzzy duplicates,
 * read the dry run, commit in one batch, and undo the whole batch within 7 days. `?import=<id>` opens one import
 * at the step its progress has reached.
 * Cues and guest list entries (P3) import into a running order or a project the person may write, so for those
 * targets the list asks app.import_destinations (one call per target) rather than the org-wide capabilities.
 * `?target=cues&runOfShow=<id>` and `?target=guest_list_entries&project=<id>` preselect the target and destination,
 * as the Import cues and Import guests links do.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/import">) {
  const ctx = await requireNode("import", await params);
  const query = await searchParams;
  const { t, dateTime } = await getFormatters(ctx);
  const title = t("imports.title");
  const importId = typeof query["import"] === "string" ? query["import"] : null;
  const text = (key: string) => {
    const v = query[key];
    return typeof v === "string" && UUID.test(v) ? v : null;
  };
  const [targets, flags] = await Promise.all([
    listImportTargets(ctx.viewer.db),
    importFlags(ctx.viewer.db, ctx.org.id),
  ]);
  if (!targets.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("imports.loadError")} />
      </TemplateCollection>
    );
  }
  // A destination target is allowed where the person may import into at least one running order or project.
  const preselected = (target: ImportTarget) =>
    target.destination === "run_of_show_id" ? text("runOfShow") : text("project");
  const destinations = new Map<string, ImportDestination[]>();
  await Promise.all(
    targets.data
      .filter((target) => target.destination !== null)
      .map(async (target) => {
        const listed = await listImportDestinations(ctx.viewer.db, {
          orgId: ctx.org.id,
          targetCode: target.code,
          include: preselected(target),
        });
        if (listed.ok && listed.data.length > 0) destinations.set(target.code, listed.data);
      }),
  );
  const allowed = targets.data.filter((target) =>
    target.destination === null
      ? ctx.capabilities.has(target.writeCapability)
      : destinations.has(target.code),
  );
  const destinationProps = (list: readonly ImportTarget[]) =>
    Object.fromEntries(
      list.flatMap((target) =>
        target.destination === null
          ? []
          : [
              [
                target.code,
                {
                  kind: target.destination,
                  options: (destinations.get(target.code) ?? []).map((d) => ({
                    id: d.id,
                    label: d.showDate ? `${d.label} · ${dateOnly(d.showDate)}` : d.label,
                  })),
                },
              ],
            ],
      ),
    );
  const { googleSheets, aiMapping } = flags.ok
    ? flags.data
    : { googleSheets: false, aiMapping: false };

  if (importId) {
    const detail = await getImport(ctx.viewer.db, importId);
    if (!detail.ok) {
      return (
        <TemplateCollection header={<PageHeader title={title} />}>
          {detail.error.kind === "not-found" ? (
            <ErrorPanel sentence={t("imports.notFound")} />
          ) : (
            <ErrorPanel sentence={t("imports.loadError")} />
          )}
        </TemplateCollection>
      );
    }
    const target = targets.data.find((x) => x.code === detail.data.targetCode);
    // The uploader's sample cells, only while the mapping is open (app.import_column_samples answers no rows otherwise).
    const samples =
      detail.data.status === "Mapped" && detail.data.mappingConfirmedAt === null
        ? await importColumnSamples(ctx.viewer.db, detail.data.id)
        : null;
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ImportWizard
          org={ctx.org.slug}
          detail={detail.data}
          fields={target?.fields ?? []}
          targets={allowed.map((x) => x.code)}
          destinations={destinationProps(allowed)}
          samples={samples?.ok ? samples.data : []}
          aiMapping={aiMapping}
          committedAt={
            detail.data.batches[0]?.committedAt
              ? dateTime(detail.data.batches[0].committedAt)
              : null
          }
        />
      </TemplateCollection>
    );
  }

  const imports = await listImports(ctx.viewer.db, ctx.org.id);
  return (
    <TemplateCollection
      header={<PageHeader title={title} {...(imports.ok ? { count: imports.data.length } : {})} />}
    >
      {!imports.ok ? (
        <ErrorPanel sentence={t("imports.loadError")} />
      ) : (
        <ImportList
          org={ctx.org.slug}
          targets={allowed.map((x) => x.code)}
          destinations={destinationProps(allowed)}
          initial={initialChoice(allowed, query["target"], preselected)}
          googleSheets={googleSheets}
          imports={imports.data.map((i) => ({ ...i, when: dateTime(i.createdAt) }))}
        />
      )}
    </TemplateCollection>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A show date (YYYY-MM-DD) as written, so the label reads the same in every time zone. */
const dateOnly = (date: string) => date.slice(0, 10);

/** The target and destination a link preselects, when the person may import there. */
function initialChoice(
  allowed: readonly ImportTarget[],
  target: string | string[] | undefined,
  preselected: (target: ImportTarget) => string | null,
): { target: string; destination: string | null } | undefined {
  const chosen = allowed.find((x) => x.code === target);
  if (!chosen) return undefined;
  return { target: chosen.code, destination: chosen.destination ? preselected(chosen) : null };
}
