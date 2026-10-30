import { listAttachments } from "@xos/data/attachments";
import { listProjectOptions, listSitePlans } from "@xos/data/places";
import {
  listPoLineOptions,
  listSigns,
  nextSignStep,
  SIGN_PRODUCTION_STATES,
  signageSummary,
  type Sign,
  type SignProductionState,
} from "@xos/data/signage";
import { listVendors } from "@xos/data/vendors";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter, getLocale } from "next-intl/server";
import { CustomFieldList } from "@/components/custom-fields/list";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { customFieldList } from "@/lib/custom-fields/server";
import { documentHref } from "@/lib/documents/links";
import { getShellSettings } from "@/lib/shell/org-settings";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { unitSystemFor } from "@/lib/workforce/units";
import { DownloadLink } from "@/components/ui";
import { heldCapabilities } from "../kit/access";
import { PeekBoard, PeekTable, QueryDrawer } from "../kit/client";
import { Collaboration } from "../kit/collaboration";
import {
  Collection,
  CollectionEmpty,
  CreateLink,
  EntityList,
  LinkFilter,
  RecordSection,
  SearchBox,
  type Search,
} from "../kit/parts";
import { InlineAlert, PropertyList, Tag } from "../kit/ui";
import { chooseView, matchesSearch, param, withQuery } from "../kit/views";
import { SignArtwork, SignSteps } from "./sign-steps";
import { SignForm, type PlanChoice } from "./sign-form";

const NODE = "places.signage";

const STATE_TOKEN: Readonly<
  Record<SignProductionState, "proposed" | "scheduled" | "active" | "complete">
> = {
  "To Order": "proposed",
  Ordered: "scheduled",
  Printed: "active",
  Placed: "complete",
};

const stateKey = (s: SignProductionState) => s.replace(/\s/g, "");

/**
 * Places > Signage (G-24, ADR 0140): the signage register of the org's projects in list, table and board views, with
 * the counts that need attention (printed but not placed, without a location, overdue). The board groups signs by
 * their computed state and does not drag: a sign moves by its step actions, and procurement's own rows move it when it
 * is ordered on a purchase order line.
 */
export async function SignagePage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  const db = ctx.viewer.db;
  const projectFilter = param(search, "project");
  const stateFilter = param(search, "state");
  const [signs, projects, plans, vendors, summary, t, held, custom, format, shell, locale] =
    await Promise.all([
      listSigns(db, { orgId: ctx.org.id, ...(projectFilter ? { projectId: projectFilter } : {}) }),
      listProjectOptions(db, ctx.org.id),
      listSitePlans(db, {
        orgId: ctx.org.id,
        ...(projectFilter ? { projectId: projectFilter } : {}),
      }),
      listVendors(db, ctx.org.id),
      signageSummary(db, {
        orgId: ctx.org.id,
        ...(projectFilter ? { projectId: projectFilter } : {}),
      }),
      getTranslate(),
      heldCapabilities(ctx),
      customFieldList(ctx, "app.signs", search),
      getFormatter(),
      getShellSettings(db, ctx.org.id, null),
      getLocale(),
    ]);
  for (const r of [signs, projects, plans, summary]) {
    if (!r.ok) throw new Error(`Cannot load signage: ${JSON.stringify(r.error)}`);
  }
  if (!signs.ok || !projects.ok || !plans.ok || !summary.ok) return null;
  const units = unitSystemFor(shell.preferences.units, null, locale);
  const canWrite = held.has("places.site_plan.write");
  const readsOrders = held.has("procurement.po.read");
  const path = nodeHref(NODE, params) ?? "/";
  const projectLabel = new Map(projects.data.map((p) => [p.id, `${p.key} ${p.name}`]));
  const projectOptions = projects.data.map((p) => ({ id: p.id, label: `${p.key} ${p.name}` }));
  const vendorOptions = (vendors.ok ? vendors.data : []).flatMap((v) =>
    v.name ? [{ id: v.id, name: v.name }] : [],
  );
  const vendorName = new Map(vendorOptions.map((v) => [v.id, v.name]));
  const planChoices: PlanChoice[] = plans.data.map((p) => ({
    id: p.id,
    title: p.title,
    projectId: p.projectId,
    draft: p.planState === "Draft",
    pins: p.pins.map((pin) => ({ id: pin.id, label: pin.label })),
  }));
  const pinPlace = new Map(
    plans.data.flatMap((p) => p.pins.map((pin) => [pin.id, `${p.title}: ${pin.label}`] as const)),
  );
  const q = param(search, "q");
  const rows = signs.data.filter(
    (s) =>
      custom.keep(s.id) &&
      (!stateFilter || stateKey(s.state) === stateFilter) &&
      matchesSearch(q, s.key, s.title, s.message, s.locationText),
  );
  const totals = summary.data.reduce(
    (n, s) => ({
      unplaced: n.unplaced + s.unplaced,
      unlocated: n.unlocated + s.unlocated,
      overdue: n.overdue + s.overdue,
    }),
    { unplaced: 0, unlocated: 0, overdue: 0 },
  );
  const location = (s: Sign) =>
    s.sitePlanPinId
      ? (pinPlace.get(s.sitePlanPinId) ?? t("places.signage.pinGone"))
      : (s.locationText ?? t("places.signage.unlocated"));
  const size = (s: Sign) =>
    s.widthIn === null || s.heightIn === null
      ? t("places.kit.notRecorded")
      : units === "metric"
        ? t("places.signage.sizeCm", {
            width: format.number(s.widthIn * 2.54, { maximumFractionDigits: 1 }),
            height: format.number(s.heightIn * 2.54, { maximumFractionDigits: 1 }),
          })
        : t("places.signage.sizeIn", {
            width: format.number(s.widthIn),
            height: format.number(s.heightIn),
          });
  const peekId = param(search, "peek");
  const selected = peekId ? signs.data.find((s) => s.id === peekId) : undefined;
  const buildSheetProject = projectFilter ?? selected?.projectId;

  const detail = async (sign: Sign) => {
    const [attachments, poLines] = await Promise.all([
      listAttachments(db, { table: "app.signs", id: sign.id }),
      readsOrders ? listPoLineOptions(db, sign.projectId) : Promise.resolve(null),
    ]);
    const files = attachments.ok ? attachments.data : [];
    const line = poLines?.ok ? poLines.data.find((l) => l.id === sign.poLineId) : undefined;
    return (
      <div className="flex flex-col gap-16">
        <PropertyList
          items={[
            { label: t("places.signage.fields.key"), value: sign.key },
            {
              label: t("places.plans.fields.project"),
              value: projectLabel.get(sign.projectId) ?? "",
            },
            {
              label: t("places.signage.fields.type"),
              value: t(`places.signage.types.${sign.type}`),
            },
            {
              label: t("places.signage.fields.state"),
              value: t(`places.signage.states.${stateKey(sign.state)}`),
            },
            { label: t("places.signage.fields.quantity"), value: format.number(sign.quantity) },
            { label: t("places.signage.fields.size"), value: size(sign) },
            {
              label: t("places.signage.fields.substrate"),
              value: sign.substrate ?? t("places.kit.notRecorded"),
            },
            { label: t("places.signage.fields.location"), value: location(sign) },
            {
              label: t("places.signage.fields.printer"),
              value: sign.orderedViaPo
                ? (line?.vendorName ?? t("places.signage.orderedByPo"))
                : sign.printerVendorId
                  ? (vendorName.get(sign.printerVendorId) ?? "")
                  : t("places.kit.notRecorded"),
            },
            ...(line
              ? [
                  {
                    label: t("places.signage.fields.poLine"),
                    value: t("places.signage.fields.poLineOption", {
                      po: line.poNumber,
                      n: line.lineNumber,
                      description: line.description,
                    }),
                  },
                ]
              : []),
            {
              label: t("places.signage.fields.neededBy"),
              value: sign.neededBy
                ? format.dateTime(new Date(`${sign.neededBy}T12:00:00`), { dateStyle: "medium" })
                : t("places.kit.notRecorded"),
            },
          ]}
        />
        {sign.message ? (
          <p className="m-0 whitespace-pre-wrap text-text-14">{sign.message}</p>
        ) : null}
        {sign.overdue ? (
          <InlineAlert tone="warning">{t("places.signage.overdueNotice")}</InlineAlert>
        ) : null}
        {canWrite ? <SignSteps org={ctx.org.slug} sign={sign} /> : null}
        <SignArtwork
          org={ctx.org.slug}
          sign={sign}
          canWrite={canWrite}
          files={files.map((a) => ({
            attachment: a,
            versionId: a.current?.id ?? null,
            isArtwork: a.versions.some((v) => v.id === sign.artworkVersionId),
          }))}
        />
        <CustomFieldsPanel org={ctx.org.slug} table="app.signs" id={sign.id} />
        {canWrite ? (
          <RecordSection id="sign-edit" title={t("places.kit.edit")}>
            <SignForm
              org={ctx.org.slug}
              sign={sign}
              projects={projectOptions}
              plans={planChoices}
              vendors={vendorOptions}
              poLines={poLines && poLines.ok ? poLines.data : null}
              units={units}
            />
          </RecordSection>
        ) : null}
        <Collaboration
          db={db}
          org={ctx.org.slug}
          subject={{ table: "app.signs", id: sign.id }}
          me={ctx.viewer.person?.id ?? null}
          canPost
        />
      </div>
    );
  };

  const views = chooseView(NODE, param(search, "view"), {
    board: rows.length > 0,
    table: rows.length > 0,
  });
  let overlay = null;
  if (param(search, "create") === "1" && canWrite && projectOptions.length > 0) {
    const createProject = projectFilter ?? projectOptions[0]?.id;
    const poLines =
      readsOrders && createProject ? await listPoLineOptions(db, createProject) : null;
    overlay = (
      <QueryDrawer title={t("places.signage.create")} closeKeys={["create"]}>
        <SignForm
          org={ctx.org.slug}
          projects={projectOptions}
          {...(projectFilter ? { defaultProjectId: projectFilter } : {})}
          plans={planChoices}
          vendors={vendorOptions}
          poLines={poLines && poLines.ok ? poLines.data : null}
          units={units}
        />
      </QueryDrawer>
    );
  } else if (peekId) {
    overlay = (
      <QueryDrawer title={t("places.signage.peekTitle")} closeKeys={["peek"]}>
        {selected ? (
          <div className="flex flex-col gap-16">
            <h3 className="m-0 flex flex-wrap items-center gap-8 text-heading-20 font-semibold">
              {selected.key} {selected.title}
            </h3>
            {await detail(selected)}
          </div>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </QueryDrawer>
    );
  }

  const chip = (s: Sign) => (
    <Tag tone={s.state === "Placed" ? "success" : s.state === "To Order" ? "neutral" : "accent"}>
      {t(`places.signage.states.${stateKey(s.state)}`)}
    </Tag>
  );
  let body;
  if (projectOptions.length === 0) {
    body = (
      <CollectionEmpty
        icon="FolderKanban"
        sentence={t("places.plans.noProjects")}
        actionLabel={t("places.plans.openProjects")}
        href={nodeHref("projects", params) ?? "/"}
      />
    );
  } else if (signs.data.length === 0) {
    body = canWrite ? (
      <CollectionEmpty
        icon="MapPinned"
        sentence={t("places.signage.empty")}
        actionLabel={t("places.signage.create")}
        href={withQuery(path, search, { create: "1" })}
      />
    ) : (
      <InlineAlert tone="info">{t("places.signage.emptyReadOnly")}</InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "board") {
    body = (
      <PeekBoard
        readOnly
        columns={SIGN_PRODUCTION_STATES.map((state) => ({
          state: STATE_TOKEN[state],
          label: t(`places.signage.states.${stateKey(state)}`),
          cards: rows
            .filter((s) => s.state === state)
            .map((s) => {
              const next = nextSignStep(s);
              return {
                key: s.id,
                title: `${s.key} ${s.title}`,
                meta:
                  next && canWrite
                    ? t("places.signage.nextStep", { step: t(`places.signage.steps.${next}`) })
                    : location(s),
              };
            }),
        }))}
      />
    );
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("places.signage.title")}
        pinStart={["key"]}
        columns={[
          { key: "key", label: t("places.signage.fields.key") },
          { key: "title", label: t("places.signage.fields.title") },
          { key: "type", label: t("places.signage.fields.type") },
          { key: "state", label: t("places.signage.fields.state") },
          { key: "quantity", label: t("places.signage.fields.quantity") },
          { key: "size", label: t("places.signage.fields.size") },
          { key: "location", label: t("places.signage.fields.location") },
        ]}
        rows={rows.map((s) => ({
          id: s.id,
          key: s.key,
          title: s.title,
          type: t(`places.signage.types.${s.type}`),
          state: t(`places.signage.states.${stateKey(s.state)}`),
          quantity: format.number(s.quantity),
          size: size(s),
          location: location(s),
        }))}
      />
    );
  } else {
    body = (
      <EntityList
        label={t("places.signage.title")}
        path={path}
        search={search}
        rows={rows.map((s) => ({
          id: s.id,
          title: `${s.key} ${s.title}`,
          meta: [projectLabel.get(s.projectId), location(s)].filter(Boolean).join(" · "),
          chips: (
            <>
              {chip(s)}
              {s.overdue ? <Tag tone="warning">{t("places.signage.overdue")}</Tag> : null}
            </>
          ),
        }))}
      />
    );
  }

  const collection = (
    <Collection
      title={t("places.signage.title")}
      count={rows.length}
      views={views}
      primary={
        canWrite && projectOptions.length > 0 ? (
          <CreateLink path={path} search={search} label={t("places.signage.create")} />
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("places.signage.search")} />
          <LinkFilter
            path={path}
            search={search}
            label={t("places.plans.fields.project")}
            queryKey="project"
            allLabel={t("places.plans.allProjects")}
            options={projectOptions.map((p) => ({ value: p.id, label: p.label }))}
          />
          <LinkFilter
            path={path}
            search={search}
            label={t("places.signage.fields.state")}
            queryKey="state"
            allLabel={t("places.signage.allStates")}
            options={SIGN_PRODUCTION_STATES.map((s) => ({
              value: stateKey(s),
              label: t(`places.signage.states.${stateKey(s)}`),
            }))}
          />
          <span
            className="flex flex-wrap items-center gap-8"
            aria-label={t("places.signage.attention")}
          >
            <Tag tone={totals.unplaced > 0 ? "accent" : "neutral"}>
              {t("places.signage.unplacedCount", { count: totals.unplaced })}
            </Tag>
            <Tag tone={totals.unlocated > 0 ? "warning" : "neutral"}>
              {t("places.signage.unlocatedCount", { count: totals.unlocated })}
            </Tag>
            <Tag tone={totals.overdue > 0 ? "danger" : "neutral"}>
              {t("places.signage.overdueCount", { count: totals.overdue })}
            </Tag>
          </span>
          {buildSheetProject ? (
            <DownloadLink
              href={documentHref(ctx.org.slug, "signage-build-sheet", buildSheetProject)}
            >
              {t("places.signage.buildSheet")}
            </DownloadLink>
          ) : (
            <Link
              href={withQuery(path, search, { project: projectOptions[0]?.id }) as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("places.signage.chooseProjectForSheet")}
            </Link>
          )}
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
  return (
    <CustomFieldList value={await custom.view(rows.map((s) => s.id))}>{collection}</CustomFieldList>
  );
}
