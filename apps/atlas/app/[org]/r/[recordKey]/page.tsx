import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireModuleNode } from "@/components/work/load";
import { stateToken } from "@/components/work/format";
import { loadRecordDetail, RecordBody, RecordProperties } from "@/components/work/record-detail";
import { Breadcrumbs, RecordKindChip, StateChip, TemplateRecord } from "@/components/work/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { RecordKind } from "@xos/ui";

export async function generateMetadata({
  params,
}: PageProps<"/[org]/r/[recordKey]">): Promise<Metadata> {
  return { title: (await params).recordKey };
}

/**
 * The record full page (`/{org}/r/{recordKey}`, Section 4.5.3) for any of the 26 kinds: title row
 * with key, kind and state, content and activity beside the 320 px property column (Record
 * template). A record the viewer may not read answers 404 (invariant 2, ADR 0003).
 */
export default async function RecordPage({ params }: PageProps<"/[org]/r/[recordKey]">) {
  const routeParams = await params;
  const ctx = await requireModuleNode("record", routeParams);
  const detail = await loadRecordDetail(ctx, decodeURIComponent(routeParams.recordKey));
  if (!detail) notFound();
  const t = await getTranslate();
  const { record } = detail;
  const org = ctx.org.slug;
  return (
    <TemplateRecord
      propertiesLabel={t("work.record.properties")}
      header={
        <header className="flex flex-col gap-8">
          <Breadcrumbs
            items={[
              {
                label: `${record.projectKey} · ${record.projectName}`,
                href: `/${org}/p/${record.projectKey}/work`,
              },
              { label: t("nav.atlas.items.work"), href: `/${org}/work/all-records` },
              { label: record.key },
            ]}
          />
          <div className="flex flex-wrap items-center gap-8 text-text-secondary">
            <span className="font-mono text-text-12">{record.key}</span>
            <RecordKindChip
              kind={record.kind as RecordKind}
              label={t(`work.kinds.${record.kind}`)}
            />
            <StateChip state={stateToken(record.state)} label={t(`work.states.${record.state}`)} />
            {record.deletedAt ? (
              <span className="text-text-12">{t("work.trash.inTrash")}</span>
            ) : null}
          </div>
          <h1 className="m-0 text-heading-24 font-semibold">{record.title}</h1>
        </header>
      }
      properties={<RecordProperties detail={detail} />}
    >
      <RecordBody org={org} detail={detail} me={ctx.viewer.person?.id ?? null} />
    </TemplateRecord>
  );
}
