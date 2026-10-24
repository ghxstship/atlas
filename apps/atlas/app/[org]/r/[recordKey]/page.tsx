import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireModuleNode } from "@/components/work/load";
import { stateToken } from "@/components/work/format";
import { recordBulkConfig } from "@/components/work/load";
import { loadRecordDetail, RecordBody, RecordProperties } from "@/components/work/record-detail";
import { RecordTitleRow } from "@/components/work/record-title-row";
import { Breadcrumbs, RecordKindChip, StateChip, TemplateRecord } from "@/components/work/ui";
import { ContinueOnDevice } from "@/components/handoff/continue-on-device";
import { LiveRefresh } from "@/components/live/live-refresh";
import { handoffLink } from "@/lib/handoff";
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
  // Continue on another device (Section 11.10 item 13, ADR 0030): the same record in Compass.
  const handoff = handoffLink({ kind: "record", org, recordKey: record.key });
  const item = `${record.key} · ${record.title}`;
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
          <RecordTitleRow
            org={org}
            recordId={record.id}
            recordKey={record.key}
            bulk={detail.canWrite ? recordBulkConfig(org, detail.meta, t) : null}
          >
            <span className="font-mono text-text-12">{record.key}</span>
            <RecordKindChip
              kind={record.kind as RecordKind}
              label={t(`work.kinds.${record.kind}`)}
            />
            <StateChip state={stateToken(record.state)} label={t(`work.states.${record.state}`)} />
            {record.deletedAt ? (
              <span className="text-text-12">{t("work.trash.inTrash")}</span>
            ) : null}
            <span className="ms-auto">
              <ContinueOnDevice
                url={handoff.url}
                labels={{
                  button: t("handoff.button"),
                  title: t("handoff.title"),
                  sentence: t(
                    handoff.universal ? "handoff.sentenceUniversal" : "handoff.sentence",
                    {
                      item: record.key,
                    },
                  ),
                  qr: t("handoff.qr", { item }),
                  link: t("handoff.link"),
                }}
              />
            </span>
          </RecordTitleRow>
          <h1 className="m-0 text-heading-24 font-semibold">{record.title}</h1>
        </header>
      }
      properties={<RecordProperties detail={detail} />}
    >
      {/* The record updates live when someone else changes it (Section 11.7, ADR 0044). */}
      <LiveRefresh topics={[{ table: "records", filter: `id=eq.${record.id}` }]} />
      <RecordBody org={org} detail={detail} me={ctx.viewer.person?.id ?? null} />
    </TemplateRecord>
  );
}
