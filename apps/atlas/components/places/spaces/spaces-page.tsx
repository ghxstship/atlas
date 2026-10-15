import type { XosClient } from "@xos/data";
import {
  listSitePlans,
  listSpaces,
  listUridCategories,
  listVenues,
  listZones,
  type ArchiveFilter,
  type Space,
  type UridCategory,
  type Zone,
} from "@xos/data/places";
import type { TreeNode } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { setPlaceArchivedAction } from "@/app/[org]/places/actions";
import { requireNode } from "@/components/shell/sitemap-page";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { heldCapabilities } from "../kit/access";
import { ActionButton } from "../kit/buttons";
import { PeekTable, PeekTree, QueryDrawer } from "../kit/client";
import { Collaboration } from "../kit/collaboration";
import {
  ArchiveFilter as ArchiveFilterLinks,
  BackLink,
  Collection,
  CollectionEmpty,
  EntityList,
  LinkFilter,
  RecordSection,
  SearchBox,
  type Search,
} from "../kit/parts";
import { ButtonLink } from "@/components/ui";
import { InlineAlert, MapView, PropertyList, Tag, TemplateRecord } from "../kit/ui";
import { chooseView, matchesSearch, param, withQuery } from "../kit/views";
import { SpaceForm, ZoneForm, type VenueOption } from "./forms";

const NODE = "places.spaces-and-zones";
const PLAN = { width: 800, height: 520 } as const;

type Selected = { kind: "space"; row: Space } | { kind: "zone"; row: Zone };

function parsePeek(value: string | undefined): { kind: "space" | "zone"; id: string } | null {
  const match = value?.match(/^(space|zone)-([0-9a-f-]{36})$/);
  return match ? { kind: match[1] as "space" | "zone", id: match[2] ?? "" } : null;
}

/** Spaces and zones of the org's venues (Section 4.5.5 Places): tree, list, table and site plan views. */
export async function SpacesPage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  const db = ctx.viewer.db;
  const archiveParam = param(search, "archive");
  const archive: ArchiveFilter =
    archiveParam === "archived" || archiveParam === "all" ? archiveParam : "live";
  const venueFilter = param(search, "venue");
  const [venues, spaces, zones, plans, categories, t, held] = await Promise.all([
    listVenues(db, ctx.org.id, "live"),
    listSpaces(db, {
      orgId: ctx.org.id,
      archive: "all",
      ...(venueFilter ? { venueId: venueFilter } : {}),
    }),
    listZones(db, {
      orgId: ctx.org.id,
      archive: "all",
      ...(venueFilter ? { venueId: venueFilter } : {}),
    }),
    listSitePlans(db, { orgId: ctx.org.id }),
    listUridCategories(db),
    getTranslate(),
    heldCapabilities(ctx),
  ]);
  for (const r of [venues, spaces, zones, plans, categories]) {
    if (!r.ok) throw new Error(`Cannot load spaces and zones: ${JSON.stringify(r.error)}`);
  }
  if (!venues.ok || !spaces.ok || !zones.ok || !plans.ok || !categories.ok) return null;
  const canWrite = held.has("places.space.write");
  const path = nodeHref(NODE, params) ?? "/";
  const venueOptions: VenueOption[] = venues.data.map((v) => ({ id: v.id, name: v.name }));
  const venueName = new Map(venues.data.map((v) => [v.id, v.name]));
  const spaceName = new Map(spaces.data.map((s) => [s.id, s.name]));
  const categoryName = new Map(categories.data.map((c) => [c.urid, c.name]));
  const q = param(search, "q");
  // Archived rows are loaded too, so a peek can open an archived row to restore it.
  const inArchive = (archivedAt: string | null) =>
    archive === "all" || (archive === "archived") === (archivedAt !== null);
  const liveSpaces = spaces.data.filter((s) => s.archivedAt === null);
  const shownSpaces = spaces.data.filter(
    (s) => inArchive(s.archivedAt) && matchesSearch(q, s.name, s.urid),
  );
  const shownZones = zones.data.filter(
    (z) => inArchive(z.archivedAt) && matchesSearch(q, z.name, z.code),
  );
  const zoneIds = new Set(shownZones.map((z) => z.id));
  const pinnedPlans = plans.data.filter((p) =>
    p.pins.some((pin) => pin.zoneId && zoneIds.has(pin.zoneId)),
  );

  const peek = parsePeek(param(search, "peek"));
  const selected: Selected | null = peek
    ? peek.kind === "space"
      ? (() => {
          const row = spaces.data.find((s) => s.id === peek.id);
          return row ? { kind: "space" as const, row } : null;
        })()
      : (() => {
          const row = zones.data.find((z) => z.id === peek.id);
          return row ? { kind: "zone" as const, row } : null;
        })()
    : null;
  const detail = {
    db,
    org: ctx.org.slug,
    me: ctx.viewer.person?.id ?? null,
    canWrite,
    t,
    venues: venueOptions,
    spaces: liveSpaces,
    categories: categories.data,
    venueName,
    spaceName,
    categoryName,
  };

  if (peek && param(search, "full") === "1") {
    const back = withQuery(path, search, { peek: undefined, full: undefined });
    return selected ? (
      <div className="flex flex-col gap-12">
        <BackLink href={back} label={t("places.spaces.back")} />
        <TemplateRecord
          propertiesLabel={t("places.kit.properties")}
          header={
            <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
              <h1 className="m-0 text-heading-24 font-semibold">{selected.row.name}</h1>
              <Tag>{t(`places.spaces.kind.${selected.kind}`)}</Tag>
              {selected.kind === "zone" ? <Tag>{selected.row.code}</Tag> : null}
            </header>
          }
          properties={<Properties selected={selected} {...detail} />}
        >
          <Editor selected={selected} {...detail} />
        </TemplateRecord>
      </div>
    ) : (
      <div className="flex flex-col gap-12">
        <BackLink href={back} label={t("places.spaces.back")} />
        <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
          {t("places.kit.peekMissing")}
        </InlineAlert>
      </div>
    );
  }

  const views = chooseView(NODE, param(search, "view"), {
    tree: shownSpaces.length + shownZones.length > 0,
    "site-plan": pinnedPlans.length > 0,
  });

  const create = param(search, "create");
  let overlay = null;
  if ((create === "space" || create === "zone") && canWrite && venueOptions.length > 0) {
    overlay = (
      <QueryDrawer
        title={t(create === "space" ? "places.spaces.createSpace" : "places.spaces.createZone")}
        closeKeys={["create"]}
      >
        {create === "space" ? (
          <SpaceForm
            org={ctx.org.slug}
            venues={venueOptions}
            categories={categories.data}
            {...(venueFilter ? { defaultVenueId: venueFilter } : {})}
          />
        ) : (
          <ZoneForm
            org={ctx.org.slug}
            venues={venueOptions}
            spaces={liveSpaces}
            {...(venueFilter ? { defaultVenueId: venueFilter } : {})}
          />
        )}
      </QueryDrawer>
    );
  } else if (peek) {
    overlay = (
      <QueryDrawer title={t(`places.spaces.kind.${peek.kind}`)} closeKeys={["peek"]}>
        {selected ? (
          <div className="flex flex-col gap-16">
            <div className="flex flex-wrap items-center justify-between gap-8">
              <h3 className="m-0 text-heading-20 font-semibold">{selected.row.name}</h3>
              <Link
                href={withQuery(path, search, { full: "1" }) as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("places.kit.openFull")}
              </Link>
            </div>
            <Properties selected={selected} {...detail} />
            <Editor selected={selected} {...detail} />
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
  if (venueOptions.length === 0) {
    const venuesHref = nodeHref("places.venues", params);
    body = (
      <CollectionEmpty
        icon="MapPin"
        sentence={t("places.spaces.noVenues")}
        actionLabel={t("places.venues.create")}
        href={`${venuesHref ?? "/"}?create=1`}
      />
    );
  } else if (spaces.data.length + zones.data.length === 0) {
    body = canWrite ? (
      <CollectionEmpty
        icon="LayoutGrid"
        sentence={t("places.spaces.empty")}
        actionLabel={t("places.spaces.createSpace")}
        href={withQuery(path, search, { create: "space" })}
      />
    ) : (
      <InlineAlert tone="info">{t("places.spaces.emptyReadOnly")}</InlineAlert>
    );
  } else if (shownSpaces.length + shownZones.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "tree") {
    body = (
      <PeekTree
        label={t("places.spaces.title")}
        nodes={tree(venueOptions, shownSpaces, shownZones, t)}
      />
    );
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("places.spaces.title")}
        pinStart={["name"]}
        columns={[
          { key: "name", label: t("places.spaces.fields.name") },
          { key: "kind", label: t("places.spaces.fields.kind") },
          { key: "code", label: t("places.spaces.fields.code"), type: "code" },
          { key: "venue", label: t("places.spaces.fields.venue") },
          { key: "within", label: t("places.spaces.fields.space") },
          { key: "urid", label: t("places.spaces.fields.urid"), type: "code" },
          { key: "capacity", label: t("places.spaces.fields.capacity"), type: "number" },
          { key: "area", label: t("places.spaces.fields.area"), type: "number" },
        ]}
        rows={[
          ...shownSpaces.map((s) => ({
            id: `space-${s.id}`,
            name: s.name,
            kind: t("places.spaces.kind.space"),
            code: null,
            venue: venueName.get(s.venueId) ?? null,
            within: null,
            urid: s.urid,
            capacity: s.capacity,
            area: s.areaSqFt,
          })),
          ...shownZones.map((z) => ({
            id: `zone-${z.id}`,
            name: z.name,
            kind: t("places.spaces.kind.zone"),
            code: z.code,
            venue: venueName.get(z.venueId) ?? null,
            within: z.spaceId ? (spaceName.get(z.spaceId) ?? null) : null,
            urid: null,
            capacity: null,
            area: null,
          })),
        ]}
      />
    );
  } else if (views.current === "site-plan") {
    body = (
      <div className="flex flex-col gap-24">
        {pinnedPlans.map((plan) => (
          <figure key={plan.id} className="m-0 flex flex-col gap-8">
            <figcaption className="text-text-14 font-medium">{plan.title}</figcaption>
            <MapView
              label={t("places.spaces.planLabel", { title: plan.title })}
              width={PLAN.width}
              height={PLAN.height}
              zones={[]}
              pins={plan.pins
                .filter((p) => p.zoneId && zoneIds.has(p.zoneId))
                .map((p) => ({ x: p.x * PLAN.width, y: p.y * PLAN.height, label: p.label }))}
            />
          </figure>
        ))}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-16">
        {shownSpaces.length > 0 ? (
          <EntityList
            label={t("places.spaces.spacesHeading")}
            path={path}
            search={search}
            rows={shownSpaces.map((s) => ({
              id: `space-${s.id}`,
              title: s.name,
              meta: [venueName.get(s.venueId), s.urid ? categoryName.get(s.urid) : null]
                .filter(Boolean)
                .join(" · "),
              chips: (
                <>
                  {s.capacity !== null ? (
                    <Tag>{t("places.spaces.capacityChip", { count: s.capacity })}</Tag>
                  ) : null}
                  {s.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
                </>
              ),
            }))}
          />
        ) : null}
        {shownZones.length > 0 ? (
          <EntityList
            label={t("places.spaces.zonesHeading")}
            path={path}
            search={search}
            rows={shownZones.map((z) => ({
              id: `zone-${z.id}`,
              title: z.name,
              meta: [venueName.get(z.venueId), z.spaceId ? spaceName.get(z.spaceId) : null]
                .filter(Boolean)
                .join(" · "),
              chips: (
                <>
                  <Tag>{z.code}</Tag>
                  {z.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
                </>
              ),
            }))}
          />
        ) : null}
      </div>
    );
  }

  return (
    <Collection
      title={t("places.spaces.title")}
      count={shownSpaces.length + shownZones.length}
      views={views}
      primary={
        canWrite && venueOptions.length > 0 ? (
          <div className="flex flex-wrap gap-8">
            <ButtonLink href={withQuery(path, search, { create: "zone", peek: undefined })}>
              {t("places.spaces.createZone")}
            </ButtonLink>
            <ButtonLink
              variant="primary"
              href={withQuery(path, search, { create: "space", peek: undefined })}
            >
              {t("places.spaces.createSpace")}
            </ButtonLink>
          </div>
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("places.spaces.search")} />
          <LinkFilter
            path={path}
            search={search}
            label={t("places.spaces.fields.venue")}
            queryKey="venue"
            allLabel={t("places.spaces.allVenues")}
            options={venueOptions.map((v) => ({ value: v.id, label: v.name }))}
          />
          <ArchiveFilterLinks path={path} search={search} current={archive} t={t} />
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
}

function tree(
  venues: readonly VenueOption[],
  spaces: readonly Space[],
  zones: readonly Zone[],
  t: Translate,
): TreeNode[] {
  return venues
    .map((v): TreeNode => {
      const venueSpaces = spaces.filter((s) => s.venueId === v.id);
      const loose = zones.filter(
        (z) => z.venueId === v.id && (!z.spaceId || !venueSpaces.some((s) => s.id === z.spaceId)),
      );
      const zoneNode = (z: Zone): TreeNode => ({
        id: `zone-${z.id}`,
        label: z.name,
        meta: z.code,
        icon: "Square",
      });
      return {
        label: v.name,
        icon: "Building2",
        expanded: true,
        meta: t("places.venues.counts", {
          spaces: venueSpaces.length,
          zones: zones.filter((z) => z.venueId === v.id).length,
        }),
        children: [
          ...venueSpaces.map((s): TreeNode => ({
            id: `space-${s.id}`,
            label: s.name,
            icon: "LayoutGrid",
            expanded: true,
            children: zones.filter((z) => z.spaceId === s.id).map(zoneNode),
          })),
          ...loose.map(zoneNode),
        ],
      };
    })
    .filter((n) => (n.children?.length ?? 0) > 0);
}

interface Detail {
  db: XosClient;
  org: string;
  me: string | null;
  canWrite: boolean;
  t: Translate;
  venues: readonly VenueOption[];
  spaces: readonly Space[];
  categories: readonly UridCategory[];
  venueName: ReadonlyMap<string, string>;
  spaceName: ReadonlyMap<string, string>;
  categoryName: ReadonlyMap<string, string>;
}

function Properties({
  selected,
  t,
  venueName,
  spaceName,
  categoryName,
  canWrite,
  org,
}: Detail & { selected: Selected }) {
  const unknown = t("places.spaces.notMeasured");
  const items =
    selected.kind === "space"
      ? [
          {
            label: t("places.spaces.fields.venue"),
            value: venueName.get(selected.row.venueId) ?? "",
          },
          {
            label: t("places.spaces.fields.urid"),
            value: selected.row.urid
              ? `${categoryName.get(selected.row.urid) ?? ""} ${selected.row.urid}`
              : t("places.kit.notRecorded"),
          },
          {
            label: t("places.spaces.fields.area"),
            value: selected.row.areaSqFt === null ? unknown : String(selected.row.areaSqFt),
          },
          {
            label: t("places.spaces.fields.capacity"),
            value: selected.row.capacity === null ? unknown : String(selected.row.capacity),
          },
        ]
      : [
          {
            label: t("places.spaces.fields.venue"),
            value: venueName.get(selected.row.venueId) ?? "",
          },
          { label: t("places.spaces.fields.code"), value: selected.row.code },
          {
            label: t("places.spaces.fields.space"),
            value: selected.row.spaceId
              ? (spaceName.get(selected.row.spaceId) ?? "")
              : t("places.spaces.fields.noSpace"),
          },
        ];
  return (
    <div className="flex flex-col gap-12">
      {selected.row.archivedAt ? (
        <InlineAlert tone="warning">{t("places.spaces.archivedNotice")}</InlineAlert>
      ) : null}
      <PropertyList items={items} />
      {canWrite ? (
        <ActionButton
          action={setPlaceArchivedAction}
          org={org}
          fields={{
            table: selected.kind === "space" ? "spaces" : "zones",
            id: selected.row.id,
            archived: selected.row.archivedAt ? "false" : "true",
          }}
          label={selected.row.archivedAt ? t("places.kit.restore") : t("places.kit.archive.action")}
          variant={selected.row.archivedAt ? "secondary" : "ghost"}
        />
      ) : null}
    </div>
  );
}

function Editor(props: Detail & { selected: Selected }) {
  const { selected, t, canWrite, org, venues, spaces, categories, db, me } = props;
  return (
    <>
      {canWrite ? (
        <RecordSection id="place-edit" title={t("places.kit.edit")}>
          {selected.kind === "space" ? (
            <SpaceForm org={org} space={selected.row} venues={venues} categories={categories} />
          ) : (
            <ZoneForm org={org} zone={selected.row} venues={venues} spaces={spaces} />
          )}
        </RecordSection>
      ) : null}
      <Collaboration
        db={db}
        org={org}
        subject={{
          table: selected.kind === "space" ? "app.spaces" : "app.zones",
          id: selected.row.id,
        }}
        me={me}
        canPost
      />
    </>
  );
}
