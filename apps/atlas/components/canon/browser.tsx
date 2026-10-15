import {
  listCanonExtensionProposals,
  listCanonRoles,
  listCategories,
  listDepartments,
  listDisciplines,
  listJurisdictions,
  listMetrics,
  listPhases,
  listRecordKinds,
} from "@xos/data/canon";
import type { ReactNode } from "react";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  EmptyRefresh,
  ErrorPanel,
  KitSection,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitColumn, KitRow, KitTreeNode, ViewKind } from "@/components/collection-kit/types";
import { DataTable, InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The read-only Canon browser (Section 4.2 Canon, Section 7.2): the xpms canon every tenant shares,
 * with no create or edit controls. The org's own extensions in .50 to .99 are proposed under Org
 * extensions; approved ones show beside canon here, marked as the org's.
 */

interface PageProps {
  readonly ctx: OrgContext;
  readonly path: string;
  readonly search: SearchParams;
}

interface Detail {
  readonly key: string;
  readonly title: string;
  readonly properties: { label: string; value: string }[];
  readonly content?: ReactNode;
}

/** Renders one canon collection with its peek and full page, all read-only. */
function CanonCollection({
  title,
  views,
  search,
  path,
  columns,
  rows,
  tree,
  detail,
  t,
}: {
  title: string;
  views: readonly ViewKind[];
  search: SearchParams;
  path: string;
  columns: KitColumn[];
  rows: KitRow[];
  tree?: KitTreeNode[];
  detail: (id: string) => Detail | undefined;
  t: Copy;
}) {
  const state = collectionState(search, views);
  const selected = state.peek ? detail(state.peek) : undefined;
  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("back", { page: title })}
        recordKey={selected.key}
        title={selected.title}
        properties={selected.properties}
      >
        <InlineAlert tone="info">{t("readOnly")}</InlineAlert>
        {selected.content}
      </RecordPage>
    );
  }
  return (
    <CollectionView
      title={title}
      views={views}
      view={state.view}
      columns={columns}
      rows={rows}
      {...(tree ? { tree } : {})}
      empty={<EmptyRefresh icon="BookOpen" sentence={t("empty")} />}
    >
      {selected ? (
        <PeekDrawer
          recordKey={selected.key}
          title={selected.title}
          closeHref={withQuery(path, state)}
          fullHref={withQuery(path, state, { peek: state.peek ?? "", full: "1" })}
          properties={selected.properties}
        >
          {selected.content}
        </PeekDrawer>
      ) : null}
    </CollectionView>
  );
}

function failed(title: string, t: Copy) {
  return (
    <>
      <PageHeader title={title} />
      <ErrorPanel what={t("what")} />
    </>
  );
}

const yes = (t: Copy, value: boolean) => (value ? t("yes") : t("no"));

/** Approved org extensions by code, shown beside canon rows. */
async function approvedExtensions(ctx: OrgContext) {
  const result = await listCanonExtensionProposals(ctx.viewer.db, ctx.org.id);
  return result.ok ? result.data.filter((p) => p.state === "Approved") : [];
}

export async function CanonDepartments({ ctx, path, search }: PageProps) {
  const [t, departments, disciplines] = await Promise.all([
    getCopy("canonBrowser"),
    listDepartments(ctx.viewer.db),
    listDisciplines(ctx.viewer.db),
  ]);
  const title = t("departments.title");
  if (!departments.ok || !disciplines.ok) return failed(title, t);
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "code", label: t("fields.code"), type: "code" },
        { key: "name", label: t("fields.name") },
        { key: "function", label: t("departments.coreFunction"), wrap: true },
        { key: "disciplines", label: t("departments.disciplines"), type: "number" },
      ]}
      rows={departments.data.map((d) => ({
        id: d.code,
        key: d.code,
        title: d.name,
        meta: t("departments.disciplineCount", { count: d.disciplineCount }),
        cells: {
          code: d.code,
          name: d.name,
          function: d.coreFunction,
          disciplines: d.disciplineCount,
        },
      }))}
      detail={(id) => {
        const d = departments.data.find((x) => x.code === id);
        if (!d) return undefined;
        const children = disciplines.data.filter((x) => x.departmentCode === d.code);
        return {
          key: d.code,
          title: d.name,
          properties: [
            { label: t("departments.coreFunction"), value: d.coreFunction ?? t("none") },
            { label: t("departments.scope"), value: d.scope ?? t("none") },
            { label: t("departments.disciplines"), value: String(d.disciplineCount) },
          ],
          content: (
            <KitSection id={`dept-${d.code}`} title={t("departments.disciplines")}>
              <DataTable
                caption={t("departments.disciplines")}
                columns={[
                  { key: "code", label: t("fields.code"), type: "code" },
                  { key: "name", label: t("fields.name") },
                ]}
                rows={children.map((c) => ({ code: c.code, name: c.name }))}
              />
            </KitSection>
          ),
        };
      }}
    />
  );
}

export async function CanonDisciplines({ ctx, path, search }: PageProps) {
  const [t, departments, disciplines, categories, extensions] = await Promise.all([
    getCopy("canonBrowser"),
    listDepartments(ctx.viewer.db),
    listDisciplines(ctx.viewer.db),
    listCategories(ctx.viewer.db),
    approvedExtensions(ctx),
  ]);
  const title = t("disciplines.title");
  if (!departments.ok || !disciplines.ok || !categories.ok) return failed(title, t);
  const orgDisciplines = extensions.filter((e) => e.level === "Discipline");
  const all = [
    ...disciplines.data.map((d) => ({ ...d, org: false })),
    ...orgDisciplines.map((e) => ({
      code: e.proposedCode,
      departmentCode: e.parentCode,
      name: e.label,
      source: t("orgExtension"),
      isExtension: true,
      categoryCount: 0,
      org: true,
    })),
  ].sort((a, b) => a.code.localeCompare(b.code));
  const sourceOf = (d: (typeof all)[number]) => (d.org ? t("orgExtension") : d.source);
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "tree", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "code", label: t("fields.code"), type: "code" },
        { key: "name", label: t("fields.name") },
        { key: "department", label: t("fields.department"), type: "code" },
        { key: "source", label: t("fields.source") },
        { key: "extension", label: t("fields.extension") },
        { key: "categories", label: t("disciplines.categories"), type: "number" },
      ]}
      rows={all.map((d) => ({
        id: d.code,
        key: d.code,
        title: d.name,
        meta: sourceOf(d),
        cells: {
          code: d.code,
          name: d.name,
          department: d.departmentCode,
          source: sourceOf(d),
          extension: yes(t, d.isExtension),
          categories: d.categoryCount,
        },
      }))}
      tree={departments.data.map((dept) => ({
        id: dept.code,
        label: `${dept.code} ${dept.name}`,
        children: all
          .filter((d) => d.departmentCode === dept.code)
          .map((d) => ({ id: d.code, label: `${d.code} ${d.name}`, meta: sourceOf(d) })),
      }))}
      detail={(id) => {
        const d = all.find((x) => x.code === id);
        if (!d) return undefined;
        const children = categories.data.filter((c) => c.disciplineCode === d.code);
        return {
          key: d.code,
          title: d.name,
          properties: [
            { label: t("fields.department"), value: d.departmentCode },
            { label: t("fields.source"), value: sourceOf(d) },
            { label: t("fields.extension"), value: yes(t, d.isExtension) },
          ],
          content:
            children.length > 0 ? (
              <KitSection id={`disc-${d.code}`} title={t("disciplines.categories")}>
                <DataTable
                  caption={t("disciplines.categories")}
                  columns={[
                    { key: "urid", label: t("fields.urid"), type: "code" },
                    { key: "name", label: t("fields.name") },
                  ]}
                  rows={children.map((c) => ({ urid: c.urid, name: c.name }))}
                />
              </KitSection>
            ) : undefined,
        };
      }}
    />
  );
}

export async function CanonCategories({ ctx, path, search }: PageProps) {
  const [t, disciplines, categories, extensions] = await Promise.all([
    getCopy("canonBrowser"),
    listDisciplines(ctx.viewer.db),
    listCategories(ctx.viewer.db),
    approvedExtensions(ctx),
  ]);
  const title = t("categories.title");
  if (!disciplines.ok || !categories.ok) return failed(title, t);
  const all = [
    ...categories.data.map((c) => ({ ...c, org: false })),
    ...extensions
      .filter((e) => e.level === "Category")
      .map((e) => ({
        urid: e.proposedCode,
        disciplineCode: e.parentCode,
        name: e.label,
        xyz: null,
        isExtension: true,
        org: true,
      })),
  ].sort((a, b) => a.urid.localeCompare(b.urid));
  const disciplineName = new Map(disciplines.data.map((d) => [d.code, d.name]));
  const xyzLabel = (x: string | null) => (x ? t(`xyz.${x}`) : t("none"));
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "tree", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "urid", label: t("fields.urid"), type: "code" },
        { key: "name", label: t("fields.name") },
        { key: "discipline", label: t("fields.discipline") },
        { key: "xyz", label: t("categories.xyz") },
        { key: "extension", label: t("fields.extension") },
      ]}
      rows={all.map((c) => ({
        id: c.urid,
        key: c.urid,
        title: c.name,
        meta: disciplineName.get(c.disciplineCode) ?? c.disciplineCode,
        cells: {
          urid: c.urid,
          name: c.name,
          discipline: disciplineName.get(c.disciplineCode) ?? c.disciplineCode,
          xyz: xyzLabel(c.xyz),
          extension: c.org ? t("orgExtension") : yes(t, c.isExtension),
        },
      }))}
      tree={disciplines.data
        .filter((d) => all.some((c) => c.disciplineCode === d.code))
        .map((d) => ({
          id: d.code,
          label: `${d.code} ${d.name}`,
          children: all
            .filter((c) => c.disciplineCode === d.code)
            .map((c) => ({ id: c.urid, label: `${c.urid} ${c.name}` })),
        }))}
      detail={(id) => {
        const c = all.find((x) => x.urid === id);
        if (!c) return undefined;
        return {
          key: c.urid,
          title: c.name,
          properties: [
            {
              label: t("fields.discipline"),
              value: `${c.disciplineCode} ${disciplineName.get(c.disciplineCode) ?? ""}`.trim(),
            },
            { label: t("categories.xyz"), value: xyzLabel(c.xyz) },
            {
              label: t("fields.extension"),
              value: c.org ? t("orgExtension") : yes(t, c.isExtension),
            },
          ],
        };
      }}
    />
  );
}

export async function CanonPhases({ ctx, path, search }: PageProps) {
  const [t, phases] = await Promise.all([getCopy("canonBrowser"), listPhases(ctx.viewer.db)]);
  const title = t("phases.title");
  if (!phases.ok) return failed(title, t);
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "gate", label: t("phases.gate"), type: "number" },
        { key: "code", label: t("fields.code"), type: "code" },
        { key: "name", label: t("fields.name") },
        { key: "act", label: t("phases.act"), type: "code" },
        { key: "criteria", label: t("phases.criteria"), type: "number" },
        { key: "exit", label: t("phases.exit"), wrap: true },
      ]}
      rows={phases.data.map((p) => ({
        id: p.code,
        key: p.code,
        title: p.name,
        meta: t("phases.gateLine", { gate: p.gate, act: p.actCode }),
        cells: {
          gate: p.gate,
          code: p.code,
          name: p.name,
          act: p.actCode,
          criteria: p.criteria.length,
          exit: p.gateExit,
        },
      }))}
      detail={(id) => {
        const p = phases.data.find((x) => x.code === id);
        if (!p) return undefined;
        return {
          key: p.code,
          title: p.name,
          properties: [
            { label: t("phases.gate"), value: String(p.gate) },
            { label: t("phases.act"), value: p.actCode },
            { label: t("phases.definition"), value: p.definition },
            { label: t("phases.exit"), value: p.gateExit },
          ],
          content: (
            <KitSection id={`gate-${p.code}`} title={t("phases.criteria")}>
              <DataTable
                caption={t("phases.criteria")}
                columns={[
                  { key: "id", label: t("fields.code"), type: "code" },
                  { key: "statement", label: t("phases.statement"), wrap: true },
                  { key: "blocking", label: t("phases.blocking") },
                ]}
                rows={p.criteria.map((c) => ({
                  id: c.id,
                  statement: c.statement,
                  blocking: yes(t, c.isBlocking),
                }))}
              />
            </KitSection>
          ),
        };
      }}
    />
  );
}

export async function CanonRecordKinds({ ctx, path, search }: PageProps) {
  const [t, kinds] = await Promise.all([getCopy("canonBrowser"), listRecordKinds(ctx.viewer.db)]);
  const title = t("recordKinds.title");
  if (!kinds.ok) return failed(title, t);
  const idOf = (kind: string) => kind.replace(/[^A-Za-z0-9]+/g, "-");
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "kind", label: t("recordKinds.kind") },
        { key: "class", label: t("recordKinds.class") },
        { key: "subtypes", label: t("recordKinds.subtypes"), type: "number" },
        { key: "definition", label: t("recordKinds.definition"), wrap: true },
      ]}
      rows={kinds.data.map((k) => ({
        id: idOf(k.kind),
        key: k.recordClass,
        title: k.kind,
        meta: k.definition,
        cells: {
          kind: k.kind,
          class: k.recordClass,
          subtypes: k.subtypes.length,
          definition: k.definition,
        },
      }))}
      detail={(id) => {
        const k = kinds.data.find((x) => idOf(x.kind) === id);
        if (!k) return undefined;
        return {
          key: k.recordClass,
          title: k.kind,
          properties: [
            { label: t("recordKinds.definition"), value: k.definition },
            { label: t("recordKinds.done"), value: k.definitionOfDone },
            { label: t("recordKinds.grammar"), value: k.titleGrammar },
          ],
          content: (
            <KitSection id={`kind-${id}`} title={t("recordKinds.subtypes")}>
              <ul className="m-0 flex list-none flex-wrap gap-8 p-0 text-text-13">
                {k.subtypes.map((s) => (
                  <li key={s} className="rounded-chip border border-border-subtle px-8 py-2">
                    {s}
                  </li>
                ))}
              </ul>
            </KitSection>
          ),
        };
      }}
    />
  );
}

export async function CanonRoles({ ctx, path, search }: PageProps) {
  const [t, roles, departments] = await Promise.all([
    getCopy("canonBrowser"),
    listCanonRoles(ctx.viewer.db),
    listDepartments(ctx.viewer.db),
  ]);
  const title = t("roles.title");
  if (!roles.ok || !departments.ok) return failed(title, t);
  const deptName = new Map(departments.data.map((d) => [d.code, d.name]));
  const ratio = (r: (typeof roles.data)[number]) =>
    r.staffingRatio === null
      ? t("none")
      : t("roles.ratioLine", { ratio: r.staffingRatio, basis: r.ratioBasis ?? "" });
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "code", label: t("fields.code"), type: "code" },
        { key: "name", label: t("roles.function") },
        { key: "title", label: t("roles.jobTitle") },
        { key: "department", label: t("fields.department") },
        { key: "ratio", label: t("roles.ratio"), wrap: true },
      ]}
      rows={roles.data.map((r) => ({
        id: r.code,
        key: r.code,
        title: r.name,
        meta: r.jobTitle ?? "",
        cells: {
          code: r.code,
          name: r.name,
          title: r.jobTitle,
          department: deptName.get(r.departmentCode) ?? r.departmentCode,
          ratio: ratio(r),
        },
      }))}
      detail={(id) => {
        const r = roles.data.find((x) => x.code === id);
        if (!r) return undefined;
        return {
          key: r.code,
          title: r.name,
          properties: [
            { label: t("roles.jobTitle"), value: r.jobTitle ?? t("none") },
            {
              label: t("fields.department"),
              value: deptName.get(r.departmentCode) ?? r.departmentCode,
            },
            { label: t("roles.ratio"), value: ratio(r) },
          ],
        };
      }}
    />
  );
}

export async function CanonJurisdictions({ ctx, path, search }: PageProps) {
  const [t, jurisdictions] = await Promise.all([
    getCopy("canonBrowser"),
    listJurisdictions(ctx.viewer.db),
  ]);
  const title = t("jurisdictions.title");
  if (!jurisdictions.ok) return failed(title, t);
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "id", label: t("fields.code"), type: "code" },
        { key: "level", label: t("jurisdictions.level") },
        { key: "parent", label: t("jurisdictions.parent"), type: "code" },
        { key: "status", label: t("jurisdictions.status") },
        { key: "rules", label: t("jurisdictions.rules"), type: "number" },
      ]}
      rows={jurisdictions.data.map((j) => ({
        id: j.id,
        key: j.id,
        title: t(`jurisdictions.levels.${j.level}`),
        meta: t(`jurisdictions.statuses.${j.status}`),
        cells: {
          id: j.id,
          level: t(`jurisdictions.levels.${j.level}`),
          parent: j.parent,
          status: t(`jurisdictions.statuses.${j.status}`),
          rules: j.permitRules.length,
        },
      }))}
      detail={(id) => {
        const j = jurisdictions.data.find((x) => x.id === id);
        if (!j) return undefined;
        return {
          key: j.id,
          title: t(`jurisdictions.levels.${j.level}`),
          properties: [
            { label: t("jurisdictions.parent"), value: j.parent ?? t("none") },
            { label: t("jurisdictions.status"), value: t(`jurisdictions.statuses.${j.status}`) },
            { label: t("jurisdictions.currency"), value: j.currency ?? t("inherited") },
            { label: t("jurisdictions.units"), value: j.unitSystem ?? t("inherited") },
            { label: t("jurisdictions.note"), value: j.note ?? t("none") },
          ],
          content: (
            <KitSection id={`rules-${j.id}`} title={t("jurisdictions.rules")}>
              {j.status === "declared-unpopulated" ? (
                <InlineAlert tone="info">{t("jurisdictions.unpopulated")}</InlineAlert>
              ) : j.permitRules.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("jurisdictions.noRules")}</p>
              ) : (
                <DataTable
                  caption={t("jurisdictions.rules")}
                  columns={[
                    { key: "rule", label: t("jurisdictions.rule") },
                    { key: "permit", label: t("jurisdictions.permit"), wrap: true },
                    { key: "ahj", label: t("jurisdictions.ahj") },
                    { key: "lead", label: t("jurisdictions.leadTime") },
                    { key: "condition", label: t("jurisdictions.condition"), wrap: true },
                  ]}
                  rows={j.permitRules.map((r) => ({
                    rule: r.rule,
                    permit: r.permit,
                    ahj: r.ahj,
                    lead: r.leadTime,
                    condition: r.condition,
                  }))}
                />
              )}
            </KitSection>
          ),
        };
      }}
    />
  );
}

export async function CanonMetrics({ ctx, path, search }: PageProps) {
  const [t, metrics] = await Promise.all([getCopy("canonBrowser"), listMetrics(ctx.viewer.db)]);
  const title = t("metrics.title");
  if (!metrics.ok) return failed(title, t);
  const rows = metrics.data.map((m, i) => ({ ...m, id: `metric-${i + 1}` }));
  return (
    <CanonCollection
      t={t}
      title={title}
      views={["table", "list"]}
      search={search}
      path={path}
      columns={[
        { key: "domain", label: t("metrics.domain") },
        { key: "item", label: t("metrics.item"), wrap: true },
        { key: "value", label: t("metrics.value") },
        { key: "qualifier", label: t("metrics.qualifier"), wrap: true },
        { key: "jurisdiction", label: t("metrics.jurisdiction"), type: "code" },
      ]}
      rows={rows.map((m) => ({
        id: m.id,
        key: m.domain,
        title: m.item,
        meta: String(m.value),
        cells: {
          domain: m.domain,
          item: m.item,
          value: String(m.value),
          qualifier: m.qualifier,
          jurisdiction: m.jurisdictionId ?? t("neutral"),
        },
      }))}
      detail={(id) => {
        const m = rows.find((x) => x.id === id);
        if (!m) return undefined;
        return {
          key: m.domain,
          title: m.item,
          properties: [
            { label: t("metrics.value"), value: String(m.value) },
            { label: t("metrics.qualifier"), value: m.qualifier ?? t("none") },
            { label: t("metrics.source"), value: m.source ?? t("none") },
            { label: t("metrics.jurisdiction"), value: m.jurisdictionId ?? t("neutral") },
            { label: t("metrics.provenance"), value: m.provenance },
          ],
        };
      }}
    />
  );
}
