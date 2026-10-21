import { getImport, importFlags, listImports, listImportTargets } from "@xos/data/imports";
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
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/import">) {
  const ctx = await requireNode("import", await params);
  const query = await searchParams;
  const { t, dateTime } = await getFormatters(ctx);
  const title = t("imports.title");
  const importId = typeof query["import"] === "string" ? query["import"] : null;
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
  const allowed = targets.data.filter((target) => ctx.capabilities.has(target.writeCapability));
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
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ImportWizard
          org={ctx.org.slug}
          detail={detail.data}
          fields={target?.fields ?? []}
          targets={allowed.map((x) => x.code)}
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
          googleSheets={googleSheets}
          imports={imports.data.map((i) => ({ ...i, when: dateTime(i.createdAt) }))}
        />
      )}
    </TemplateCollection>
  );
}
