import {
  getVenue,
  listJurisdictions,
  listVenues,
  type ArchiveFilter,
  type Jurisdiction,
  type Venue,
} from "@xos/data/places";
import { listCapabilityStatements, type CapabilityStatement } from "@xos/data/reconciliation";
import type { XosClient } from "@xos/data";
import { getLocationDefaults, NO_LOCATION_DEFAULTS } from "@xos/data/org-setup";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { requireNode } from "@/lib/shell/require-node";
import { CustomFieldList } from "@/components/custom-fields/list";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { customFieldList } from "@/lib/custom-fields/server";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { setPlaceArchivedAction } from "@/app/[org]/places/actions";
import { heldCapabilities } from "../kit/access";
import { Collaboration } from "../kit/collaboration";
import { ActionButton } from "../kit/buttons";
import { PeekTable, QueryDrawer } from "../kit/client";
import {
  BackLink,
  Collection,
  CollectionEmpty,
  CreateLink,
  EntityList,
  RecordSection,
  SearchBox,
  type Search,
} from "../kit/parts";
import { InlineAlert, PropertyList, Tag, TemplateRecord } from "../kit/ui";
import { MapView } from "@/components/platform/client/map-view";
import { chooseView, matchesSearch, param, withQuery } from "../kit/views";
import { VenueForm } from "./venue-form";
import { ArchivedFilter } from "@/components/archive/archived-filter";
import { archivedOf } from "@/lib/archive/param";

const NODE = "places.venues";
const MAP = { width: 800, height: 480, margin: 40 } as const;

/** The Archived filter (`?archived=include|only`, A124) as the venue list reads it. */
function archiveOf(search: Search): ArchiveFilter {
  const value = archivedOf(search);
  return value === "only" ? "archived" : value === "include" ? "all" : "live";
}

function address(v: Venue): string | null {
  const parts = [v.streetAddress, v.locality, v.postalCode].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Projects located venues into the drawing box; venues without a location are left out. */
export function projectVenues(venues: readonly Venue[]) {
  const located = venues.filter(
    (v): v is Venue & { latitude: number; longitude: number } =>
      v.latitude !== null && v.longitude !== null,
  );
  if (located.length === 0) return [];
  const lats = located.map((v) => v.latitude);
  const lngs = located.map((v) => v.longitude);
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const span = (lo: number, hi: number) => (hi - lo === 0 ? 1 : hi - lo);
  const innerW = MAP.width - MAP.margin * 2;
  const innerH = MAP.height - MAP.margin * 2;
  return located.map((v) => ({
    id: v.id,
    label: v.name,
    x:
      MAP.margin +
      (located.length === 1 ? innerW / 2 : ((v.longitude - west) / span(west, east)) * innerW),
    y:
      MAP.margin +
      (located.length === 1 ? innerH / 2 : ((north - v.latitude) / span(south, north)) * innerH),
  }));
}

/** The Venues page (Section 4.5.5 Places): list, table and map views, peek, full page and create. */
export async function VenuesPage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  const db = ctx.viewer.db;
  const archive = archiveOf(search);
  const [venues, jurisdictions, t, held, custom] = await Promise.all([
    listVenues(db, ctx.org.id, archive),
    listJurisdictions(db),
    getTranslate(),
    heldCapabilities(ctx),
    customFieldList(ctx, "app.venues", search),
  ]);
  if (!venues.ok) throw new Error(`Cannot list venues: ${JSON.stringify(venues.error)}`);
  if (!jurisdictions.ok) {
    throw new Error(`Cannot list jurisdictions: ${JSON.stringify(jurisdictions.error)}`);
  }
  const canWrite = held.has("places.venue.write");
  const path = nodeHref(NODE, params) ?? "/";
  const q = param(search, "q");
  const rows = venues.data.filter(
    (v) =>
      custom.keep(v.id) && matchesSearch(q, v.name, v.locality, v.jurisdictionId, v.streetAddress),
  );
  const peekId = param(search, "peek");
  const full = param(search, "full") === "1";

  if (peekId && full) {
    return (
      <VenueRecord
        db={db}
        me={ctx.viewer.person?.id ?? null}
        org={ctx.org.slug}
        id={peekId}
        backHref={withQuery(path, search, { peek: undefined, full: undefined })}
        jurisdictions={jurisdictions.data}
        canWrite={canWrite}
        t={t}
        params={params}
      />
    );
  }

  const views = chooseView(NODE, param(search, "view"), {
    map: rows.some((v) => v.latitude !== null),
    gallery: false,
  });

  let overlay = null;
  if (param(search, "create") === "1" && canWrite) {
    overlay = (
      <QueryDrawer title={t("places.venues.create")} closeKeys={["create"]}>
        <VenueForm
          org={ctx.org.slug}
          jurisdictions={jurisdictions.data}
          defaults={await getLocationDefaults(db, ctx.org.id).then((d) =>
            d.ok ? d.data : NO_LOCATION_DEFAULTS,
          )}
        />
      </QueryDrawer>
    );
  } else if (peekId) {
    overlay = (
      <QueryDrawer title={t("places.venues.peekTitle")} closeKeys={["peek"]}>
        <VenueDetail
          db={db}
          me={ctx.viewer.person?.id ?? null}
          org={ctx.org.slug}
          id={peekId}
          openFullHref={withQuery(path, search, { full: "1" })}
          jurisdictions={jurisdictions.data}
          canWrite={canWrite}
          t={t}
          params={params}
        />
      </QueryDrawer>
    );
  }

  const createHref = withQuery(path, search, { create: "1" });
  let body;
  if (venues.data.length === 0 && archive === "live") {
    body = canWrite ? (
      <CollectionEmpty
        icon="MapPin"
        sentence={t("places.venues.empty")}
        actionLabel={t("places.venues.create")}
        href={createHref}
      />
    ) : (
      <InlineAlert tone="info">{t("places.venues.emptyReadOnly")}</InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("places.venues.title")}
        pinStart={["name"]}
        columns={[
          { key: "name", label: t("places.venues.fields.name") },
          { key: "jurisdiction", label: t("places.venues.fields.jurisdiction"), type: "code" },
          { key: "timeZone", label: t("places.venues.fields.timeZone") },
          { key: "locality", label: t("places.venues.fields.locality") },
          { key: "spaces", label: t("places.venues.spaces"), type: "number" },
          { key: "zones", label: t("places.venues.zones"), type: "number" },
          { key: "documents", label: t("places.venues.documents"), type: "number" },
        ]}
        rows={rows.map((v) => ({
          id: v.id,
          name: v.name,
          jurisdiction: v.jurisdictionId,
          timeZone: v.timeZone,
          locality: v.locality,
          spaces: v.spaceCount,
          zones: v.zoneCount,
          documents: v.documentCount,
        }))}
      />
    );
  } else if (views.current === "map") {
    const pins = projectVenues(rows);
    body = (
      <div className="flex flex-col gap-8">
        <MapView
          label={t("places.venues.mapLabel")}
          width={MAP.width}
          height={MAP.height}
          zones={[]}
          pins={pins.map((p) => ({ x: p.x, y: p.y, label: p.label }))}
        />
        <p className="m-0 text-text-12 text-text-secondary">
          {t("places.venues.mapUnlocated", { count: rows.length - pins.length })}
        </p>
      </div>
    );
  } else {
    body = (
      <EntityList
        label={t("places.venues.title")}
        path={path}
        search={search}
        rows={rows.map((v) => ({
          id: v.id,
          title: v.name,
          meta: [address(v), v.timeZone].filter(Boolean).join(" · "),
          chips: (
            <>
              <Tag>{v.jurisdictionId}</Tag>
              {v.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
            </>
          ),
          trailing: (
            <span className="text-text-12 text-text-secondary">
              {t("places.venues.counts", { spaces: v.spaceCount, zones: v.zoneCount })}
            </span>
          ),
        }))}
      />
    );
  }

  const collection = (
    <Collection
      title={t("places.venues.title")}
      count={rows.length}
      views={views}
      primary={
        canWrite ? (
          <CreateLink path={path} search={search} label={t("places.venues.create")} />
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("places.venues.search")} />
          <ArchivedFilter id="venues-archived" />
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
  return (
    <CustomFieldList value={await custom.view(rows.map((v) => v.id))}>{collection}</CustomFieldList>
  );
}

interface DetailProps {
  db: XosClient;
  me: string | null;
  org: string;
  id: string;
  jurisdictions: readonly Jurisdiction[];
  canWrite: boolean;
  t: Translate;
  params: Readonly<Record<string, string>>;
}

async function loadVenue(db: XosClient, id: string) {
  const [venue, statements] = await Promise.all([
    getVenue(db, id),
    listCapabilityStatements(db, { venueId: id }),
  ]);
  if (!venue.ok) return null;
  if (!statements.ok) {
    throw new Error(`Cannot list capability statements: ${JSON.stringify(statements.error)}`);
  }
  return { venue: venue.data, statements: statements.data };
}

async function VenueProperties({ venue, t }: { venue: Venue; t: Translate }) {
  const format = await getFormatter();
  return (
    <PropertyList
      items={[
        { label: t("places.venues.fields.jurisdiction"), value: <Tag>{venue.jurisdictionId}</Tag> },
        { label: t("places.venues.fields.timeZone"), value: venue.timeZone },
        {
          label: t("places.venues.fields.address"),
          value: address(venue) ?? t("places.kit.notRecorded"),
        },
        {
          label: t("places.venues.fields.location"),
          value:
            venue.latitude === null || venue.longitude === null
              ? t("places.venues.notLocated")
              : t("places.venues.located", {
                  latitude: venue.latitude.toFixed(5),
                  longitude: venue.longitude.toFixed(5),
                }),
        },
        {
          label: t("places.kit.updated"),
          value: format.dateTime(new Date(venue.updatedAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        },
      ]}
    />
  );
}

function VenueLinks({
  venue,
  t,
  params,
}: {
  venue: Venue;
  t: Translate;
  params: Readonly<Record<string, string>>;
}) {
  const spaces = nodeHref("places.spaces-and-zones", params);
  const docs = nodeHref("places.capability-documents", params);
  return (
    <ul className="m-0 flex list-none flex-wrap gap-12 p-0 text-text-13">
      {spaces ? (
        <li>
          <Link
            className="text-accent-text underline"
            href={`${spaces}?venue=${venue.id}` as Route}
          >
            {t("places.venues.spacesLink", { spaces: venue.spaceCount, zones: venue.zoneCount })}
          </Link>
        </li>
      ) : null}
      {docs ? (
        <li>
          <Link className="text-accent-text underline" href={`${docs}?venue=${venue.id}` as Route}>
            {t("places.venues.documentsLink", { count: venue.documentCount })}
          </Link>
        </li>
      ) : null}
    </ul>
  );
}

function ProvidedCapabilities({
  statements,
  t,
}: {
  statements: readonly CapabilityStatement[];
  t: Translate;
}) {
  return (
    <RecordSection id="venue-capabilities" title={t("places.venues.capabilities")}>
      {statements.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("places.venues.noCapabilities")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-6 p-0">
          {statements.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-6 text-text-13">
              <span className="font-mono text-text-12">{s.urid}</span>
              <span>{s.description}</span>
              <Tag tone={s.assertionWord === "UNKNOWN" ? "warning" : "neutral"}>
                {s.assertionWord}
              </Tag>
            </li>
          ))}
        </ul>
      )}
    </RecordSection>
  );
}

function ArchiveControl({ org, venue, t }: { org: string; venue: Venue; t: Translate }) {
  return (
    <ActionButton
      action={setPlaceArchivedAction}
      org={org}
      fields={{ table: "venues", id: venue.id, archived: venue.archivedAt ? "false" : "true" }}
      label={venue.archivedAt ? t("places.kit.restore") : t("places.kit.archive.action")}
      variant={venue.archivedAt ? "secondary" : "ghost"}
    />
  );
}

/** The venue peek: properties, links, capabilities, edit and archive. */
async function VenueDetail(props: DetailProps & { openFullHref: string }) {
  const { org, id, jurisdictions, canWrite, t, params } = props;
  const loaded = await loadVenue(props.db, id);
  if (!loaded) {
    return (
      <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
        {t("places.kit.peekMissing")}
      </InlineAlert>
    );
  }
  const { venue, statements } = loaded;
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h3 className="m-0 text-heading-20 font-semibold">{venue.name}</h3>
        <Link
          href={props.openFullHref as Route}
          className="text-text-13 text-accent-text underline"
        >
          {t("places.kit.openFull")}
        </Link>
      </div>
      {venue.archivedAt ? (
        <InlineAlert tone="warning">{t("places.venues.archivedNotice")}</InlineAlert>
      ) : null}
      <VenueProperties venue={venue} t={t} />
      <VenueLinks venue={venue} t={t} params={params} />
      <ProvidedCapabilities statements={statements} t={t} />
      <CustomFieldsPanel org={org} table="app.venues" id={venue.id} />
      {canWrite ? (
        <RecordSection id="venue-edit" title={t("places.kit.edit")}>
          <VenueForm org={org} venue={venue} jurisdictions={jurisdictions} />
          <ArchiveControl org={org} venue={venue} t={t} />
        </RecordSection>
      ) : null}
      <Collaboration
        db={props.db}
        org={org}
        subject={{ table: "app.venues", id: venue.id }}
        me={props.me}
        canPost
      />
    </div>
  );
}

/** The venue full page: the Record template with the property column (Section 11.6). */
async function VenueRecord(props: DetailProps & { backHref: string }) {
  const { org, id, jurisdictions, canWrite, t, params } = props;
  const loaded = await loadVenue(props.db, id);
  if (!loaded) {
    return (
      <div className="flex flex-col gap-12">
        <BackLink href={props.backHref} label={t("places.venues.back")} />
        <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
          {t("places.kit.peekMissing")}
        </InlineAlert>
      </div>
    );
  }
  const { venue, statements } = loaded;
  return (
    <div className="flex flex-col gap-12">
      <BackLink href={props.backHref} label={t("places.venues.back")} />
      <TemplateRecord
        propertiesLabel={t("places.kit.properties")}
        header={
          <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
            <h1 className="m-0 text-heading-24 font-semibold">{venue.name}</h1>
            <Tag>{venue.jurisdictionId}</Tag>
            {venue.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
          </header>
        }
        properties={
          <div className="flex flex-col gap-16">
            <VenueProperties venue={venue} t={t} />
            {canWrite ? <ArchiveControl org={org} venue={venue} t={t} /> : null}
          </div>
        }
      >
        <VenueLinks venue={venue} t={t} params={params} />
        <ProvidedCapabilities statements={statements} t={t} />
        <CustomFieldsPanel org={org} table="app.venues" id={venue.id} />
        {canWrite ? (
          <RecordSection id="venue-edit" title={t("places.kit.edit")}>
            <VenueForm org={org} venue={venue} jurisdictions={jurisdictions} />
          </RecordSection>
        ) : null}
        <Collaboration
          db={props.db}
          org={org}
          subject={{ table: "app.venues", id: venue.id }}
          me={props.me}
          canPost
        />
      </TemplateRecord>
    </div>
  );
}
