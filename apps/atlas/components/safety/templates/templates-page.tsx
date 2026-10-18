import { listInspectionTemplates, type InspectionTemplate } from "@xos/data/safety-permits";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { moveItemAction, setSafetyArchivedAction } from "@/app/[org]/safety/actions";
import { heldCapabilities } from "@/components/places/kit/access";
import { ActionButton } from "@/components/places/kit/buttons";
import { PeekTable, QueryDrawer } from "@/components/places/kit/client";
import { Collaboration } from "@/components/places/kit/collaboration";
import {
  ArchiveFilter as ArchiveFilterLinks,
  BackLink,
  Collection,
  CollectionEmpty,
  CreateLink,
  EntityList,
  RecordSection,
  SearchBox,
  type Search,
} from "@/components/places/kit/parts";
import { InlineAlert, PropertyList, Tag, TemplateRecord } from "@/components/places/kit/ui";
import { chooseView, matchesSearch, param, withQuery } from "@/components/places/kit/views";
import { requireNode } from "@/lib/shell/require-node";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { ItemForm, TemplateNameForm } from "./template-forms";

const NODE = "safety.inspection-templates";

/** Safety > Inspection templates (Section 4.5.5): reusable checklists with ordered, critical-flagged items. */
export async function TemplatesPage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  const db = ctx.viewer.db;
  const archiveParam = param(search, "archive");
  const archive = archiveParam === "archived" || archiveParam === "all" ? archiveParam : "live";
  const [templates, t, held] = await Promise.all([
    listInspectionTemplates(db, ctx.org.id, "all"),
    getTranslate(),
    heldCapabilities(ctx),
  ]);
  if (!templates.ok) throw new Error(`Cannot list templates: ${JSON.stringify(templates.error)}`);
  const canWrite = held.has("safety.inspection_template.write");
  const path = nodeHref(NODE, params) ?? "/";
  const q = param(search, "q");
  const inArchive = (archivedAt: string | null) =>
    archive === "all" || (archive === "archived") === (archivedAt !== null);
  const rows = templates.data.filter(
    (tpl) =>
      inArchive(tpl.archivedAt) && matchesSearch(q, tpl.name, ...tpl.items.map((i) => i.prompt)),
  );
  const peekId = param(search, "peek");
  const selected = peekId ? templates.data.find((tpl) => tpl.id === peekId) : undefined;

  if (peekId && param(search, "full") === "1") {
    return (
      <div className="flex flex-col gap-12">
        <BackLink
          href={withQuery(path, search, { peek: undefined, full: undefined })}
          label={t("permits.templates.back")}
        />
        {selected ? (
          <TemplateRecord
            propertiesLabel={t("places.kit.properties")}
            header={
              <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
                <h1 className="m-0 text-heading-24 font-semibold">{selected.name}</h1>
                {selected.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
              </header>
            }
            properties={<TemplateProperties template={selected} t={t} />}
          >
            <TemplateBody template={selected} t={t} ctx={ctx} canWrite={canWrite} />
          </TemplateRecord>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </div>
    );
  }

  const views = chooseView(NODE, param(search, "view"), {});
  let overlay = null;
  if (param(search, "create") === "1" && canWrite) {
    overlay = (
      <QueryDrawer title={t("permits.templates.create")} closeKeys={["create"]}>
        <TemplateNameForm org={ctx.org.slug} />
      </QueryDrawer>
    );
  } else if (peekId) {
    overlay = (
      <QueryDrawer title={t("permits.templates.peekTitle")} closeKeys={["peek"]}>
        {selected ? (
          <div className="flex flex-col gap-16">
            <div className="flex flex-wrap items-center justify-between gap-8">
              <h3 className="m-0 text-heading-20 font-semibold">{selected.name}</h3>
              <Link
                href={withQuery(path, search, { full: "1" }) as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("places.kit.openFull")}
              </Link>
            </div>
            <TemplateProperties template={selected} t={t} />
            <TemplateBody template={selected} t={t} ctx={ctx} canWrite={canWrite} />
          </div>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </QueryDrawer>
    );
  }

  let body;
  if (templates.data.length === 0) {
    body = canWrite ? (
      <CollectionEmpty
        icon="ListChecks"
        sentence={t("permits.templates.empty")}
        actionLabel={t("permits.templates.create")}
        href={withQuery(path, search, { create: "1" })}
      />
    ) : (
      <InlineAlert tone="info">{t("permits.templates.emptyReadOnly")}</InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("permits.templates.title")}
        pinStart={["name"]}
        columns={[
          { key: "name", label: t("permits.templates.fields.name") },
          { key: "items", label: t("permits.templates.items"), type: "number" },
          { key: "critical", label: t("permits.templates.criticalItems"), type: "number" },
          { key: "state", label: t("permits.templates.status") },
        ]}
        rows={rows.map((tpl) => ({
          id: tpl.id,
          name: tpl.name,
          items: tpl.items.length,
          critical: tpl.items.filter((i) => i.critical).length,
          state: tpl.archivedAt ? t("places.kit.archived") : t("permits.templates.live"),
        }))}
      />
    );
  } else {
    body = (
      <EntityList
        label={t("permits.templates.title")}
        path={path}
        search={search}
        rows={rows.map((tpl) => ({
          id: tpl.id,
          title: tpl.name,
          meta: t("permits.templates.itemCount", {
            count: tpl.items.length,
            critical: tpl.items.filter((i) => i.critical).length,
          }),
          chips: tpl.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null,
        }))}
      />
    );
  }

  return (
    <Collection
      title={t("permits.templates.title")}
      count={rows.length}
      views={views}
      primary={
        canWrite ? (
          <CreateLink path={path} search={search} label={t("permits.templates.create")} />
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("permits.templates.search")} />
          <ArchiveFilterLinks path={path} search={search} current={archive} t={t} />
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
}

async function TemplateProperties({ template, t }: { template: InspectionTemplate; t: Translate }) {
  const format = await getFormatter();
  return (
    <PropertyList
      items={[
        { label: t("permits.templates.items"), value: String(template.items.length) },
        {
          label: t("permits.templates.criticalItems"),
          value: String(template.items.filter((i) => i.critical).length),
        },
        {
          label: t("places.kit.updated"),
          value: format.dateTime(new Date(template.updatedAt), { dateStyle: "medium" }),
        },
      ]}
    />
  );
}

function TemplateBody({
  template,
  t,
  ctx,
  canWrite,
}: {
  template: InspectionTemplate;
  t: Translate;
  ctx: OrgContext;
  canWrite: boolean;
}) {
  const org = ctx.org.slug;
  const items = template.items;
  const parking = Math.max(0, ...items.map((i) => i.position)) + 1000;
  const editable = canWrite && !template.archivedAt;
  return (
    <div className="flex flex-col gap-16">
      {template.archivedAt ? (
        <InlineAlert tone="warning">{t("permits.templates.archivedNotice")}</InlineAlert>
      ) : null}
      <RecordSection id="template-items" title={t("permits.templates.items")}>
        {items.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {editable ? t("permits.templates.noItems") : t("permits.templates.noItemsReadOnly")}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-12 p-0">
            {items.map((item, i) => {
              const prev = items[i - 1];
              const next = items[i + 1];
              return (
                <li
                  key={item.id}
                  className="flex flex-col gap-8 border-b border-border-subtle pb-12"
                >
                  <div className="flex flex-wrap items-center gap-8 text-text-14">
                    <span className="tabular-nums text-text-secondary">
                      {t("permits.templates.position", { n: i + 1 })}
                    </span>
                    <span>{item.prompt}</span>
                    {item.critical ? (
                      <Tag tone="danger">{t("permits.templates.critical")}</Tag>
                    ) : null}
                  </div>
                  {editable ? (
                    <div className="flex flex-col gap-8">
                      <ItemForm org={org} templateId={template.id} item={item} nextPosition={0} />
                      <div className="flex flex-wrap gap-8">
                        {prev ? (
                          <ActionButton
                            action={moveItemAction}
                            org={org}
                            fields={{
                              id: item.id,
                              position: String(item.position),
                              otherId: prev.id,
                              otherPosition: String(prev.position),
                              parking: String(parking),
                            }}
                            label={t("permits.templates.moveUp", { prompt: item.prompt })}
                            variant="ghost"
                          />
                        ) : null}
                        {next ? (
                          <ActionButton
                            action={moveItemAction}
                            org={org}
                            fields={{
                              id: item.id,
                              position: String(item.position),
                              otherId: next.id,
                              otherPosition: String(next.position),
                              parking: String(parking),
                            }}
                            label={t("permits.templates.moveDown", { prompt: item.prompt })}
                            variant="ghost"
                          />
                        ) : null}
                        <ActionButton
                          action={setSafetyArchivedAction}
                          org={org}
                          fields={{ table: "inspection_items", id: item.id, archived: "true" }}
                          label={t("permits.templates.removeItem", { prompt: item.prompt })}
                          variant="ghost"
                        />
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {editable ? (
          <ItemForm
            org={org}
            templateId={template.id}
            nextPosition={Math.max(0, ...items.map((i) => i.position)) + 1}
          />
        ) : null}
      </RecordSection>
      {canWrite ? (
        <RecordSection id="template-edit" title={t("places.kit.edit")}>
          {editable ? <TemplateNameForm org={org} template={template} /> : null}
          <ActionButton
            action={setSafetyArchivedAction}
            org={org}
            fields={{
              table: "inspection_templates",
              id: template.id,
              archived: template.archivedAt ? "false" : "true",
            }}
            label={template.archivedAt ? t("places.kit.restore") : t("places.kit.archive.action")}
            variant={template.archivedAt ? "secondary" : "ghost"}
          />
        </RecordSection>
      ) : null}
      <Collaboration
        db={ctx.viewer.db}
        org={org}
        subject={{ table: "app.inspection_templates", id: template.id }}
        me={ctx.viewer.person?.id ?? null}
        canPost
      />
    </div>
  );
}
