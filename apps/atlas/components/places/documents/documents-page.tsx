import {
  documentValidity,
  listCapabilityDocuments,
  listVenues,
  type ArchiveFilter,
  type CapabilityDocument,
  type DocumentValidity,
  type Venue,
} from "@xos/data/places";
import { todayIn } from "@xos/data/calendar";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { freezeCapabilityDocumentAction, setPlaceArchivedAction } from "@/app/[org]/places/actions";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { heldCapabilities } from "../kit/access";
import { ActionButton, ConfirmButton } from "../kit/buttons";
import { PeekTable, QueryDrawer } from "../kit/client";
import { Collaboration } from "../kit/collaboration";
import {
  ArchiveFilter as ArchiveFilterLinks,
  BackLink,
  Collection,
  CollectionEmpty,
  CreateLink,
  EntityList,
  LinkFilter,
  RecordSection,
  SearchBox,
  type Search,
} from "../kit/parts";
import { InlineAlert, PropertyList, Tag, TemplateRecord } from "../kit/ui";
import { chooseView, matchesSearch, param, withQuery } from "../kit/views";
import { DocumentForm } from "./document-form";

const NODE = "places.capability-documents";

const VALIDITY_TONE: Record<DocumentValidity, "neutral" | "success" | "warning" | "danger"> = {
  upcoming: "neutral",
  valid: "success",
  stale: "danger",
};

/** Capability documents of the org's venues (Section 4.5.5 Places): list and table, freeze, validity. */
export async function DocumentsPage({
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
  const [venues, documents, t, held, format] = await Promise.all([
    listVenues(db, ctx.org.id, "live"),
    listCapabilityDocuments(db, {
      orgId: ctx.org.id,
      archive: "all",
      ...(venueFilter ? { venueId: venueFilter } : {}),
    }),
    getTranslate(),
    heldCapabilities(ctx),
    getFormatter(),
  ]);
  if (!venues.ok) throw new Error(`Cannot list venues: ${JSON.stringify(venues.error)}`);
  if (!documents.ok) throw new Error(`Cannot list documents: ${JSON.stringify(documents.error)}`);
  const canWrite = held.has("places.capability_document.write");
  const path = nodeHref(NODE, params) ?? "/";
  const venueById = new Map<string, Venue>(venues.data.map((v) => [v.id, v]));
  // Validity flips at the venue's midnight; a venue without a zone follows the org's calendar (A71).
  const orgZone = await getOrgTimeZone(ctx);
  const validityOf = (d: CapabilityDocument) =>
    documentValidity(d, todayIn(venueById.get(d.venueId)?.timeZone ?? orgZone));
  const q = param(search, "q");
  // Archived rows are loaded too, so a peek can open an archived row to restore it.
  const inArchive = (archivedAt: string | null) =>
    archive === "all" || (archive === "archived") === (archivedAt !== null);
  const rows = documents.data.filter(
    (d) =>
      inArchive(d.archivedAt) && matchesSearch(q, d.title, venueById.get(d.venueId)?.name ?? null),
  );
  const day = (iso: string | null) =>
    iso === null
      ? t("places.documents.openEnded")
      : format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const venueOptions = venues.data.map((v) => ({ id: v.id, name: v.name }));

  const peekId = param(search, "peek");
  const selected = peekId ? documents.data.find((d) => d.id === peekId) : undefined;

  const detail = (doc: CapabilityDocument) => {
    const validity = validityOf(doc);
    return (
      <div className="flex flex-col gap-16">
        {doc.frozen ? (
          <InlineAlert tone="info">{t("places.documents.frozenNotice")}</InlineAlert>
        ) : null}
        {validity === "stale" ? (
          <InlineAlert tone="warning" title={t("places.documents.staleTitle")}>
            {t("places.documents.staleBody")}
          </InlineAlert>
        ) : null}
        <PropertyList
          items={[
            {
              label: t("places.documents.fields.venue"),
              value: venueById.get(doc.venueId)?.name ?? "",
            },
            {
              label: t("places.documents.fields.uri"),
              value: <span className="break-all font-mono text-text-12">{doc.documentUri}</span>,
            },
            { label: t("places.documents.fields.validFrom"), value: day(doc.validFrom) },
            { label: t("places.documents.fields.validTo"), value: day(doc.validTo) },
            {
              label: t("places.documents.validity"),
              value: (
                <Tag tone={VALIDITY_TONE[validity]}>{t(`places.documents.state.${validity}`)}</Tag>
              ),
            },
            {
              label: t("places.documents.frozen"),
              value: doc.frozen ? t("places.documents.frozenYes") : t("places.documents.frozenNo"),
            },
          ]}
        />
        {canWrite ? (
          <div className="flex flex-wrap gap-8">
            {!doc.frozen && !doc.archivedAt ? (
              <ConfirmButton
                action={freezeCapabilityDocumentAction}
                org={ctx.org.slug}
                fields={{ id: doc.id }}
                label={t("places.documents.freeze")}
                title={t("places.documents.freezeTitle", { title: doc.title })}
                description={t("places.documents.freezeBody")}
                confirmLabel={t("places.documents.freezeConfirm")}
              />
            ) : null}
            <ActionButton
              action={setPlaceArchivedAction}
              org={ctx.org.slug}
              fields={{
                table: "capability_documents",
                id: doc.id,
                archived: doc.archivedAt ? "false" : "true",
              }}
              label={doc.archivedAt ? t("places.kit.restore") : t("places.kit.archive.action")}
              variant={doc.archivedAt ? "secondary" : "ghost"}
            />
          </div>
        ) : null}
        {canWrite && !doc.frozen ? (
          <RecordSection id="document-edit" title={t("places.kit.edit")}>
            <DocumentForm org={ctx.org.slug} document={doc} venues={venueOptions} />
          </RecordSection>
        ) : null}
        <Collaboration
          db={db}
          org={ctx.org.slug}
          subject={{ table: "app.capability_documents", id: doc.id }}
          me={ctx.viewer.person?.id ?? null}
          canPost
        />
      </div>
    );
  };

  if (peekId && param(search, "full") === "1") {
    const back = withQuery(path, search, { peek: undefined, full: undefined });
    return (
      <div className="flex flex-col gap-12">
        <BackLink href={back} label={t("places.documents.back")} />
        {selected ? (
          <TemplateRecord
            propertiesLabel={t("places.kit.properties")}
            header={
              <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
                <h1 className="m-0 text-heading-24 font-semibold">{selected.title}</h1>
                {selected.frozen ? <Tag>{t("places.documents.frozen")}</Tag> : null}
              </header>
            }
            properties={detail(selected)}
          >
            <p className="m-0 text-text-13 text-text-secondary">
              {t("places.documents.recordIntro")}
            </p>
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
  if (param(search, "create") === "1" && canWrite && venueOptions.length > 0) {
    overlay = (
      <QueryDrawer title={t("places.documents.create")} closeKeys={["create"]}>
        <DocumentForm
          org={ctx.org.slug}
          venues={venueOptions}
          {...(venueFilter ? { defaultVenueId: venueFilter } : {})}
        />
      </QueryDrawer>
    );
  } else if (peekId) {
    overlay = (
      <QueryDrawer title={t("places.documents.peekTitle")} closeKeys={["peek"]}>
        {selected ? (
          <div className="flex flex-col gap-16">
            <div className="flex flex-wrap items-center justify-between gap-8">
              <h3 className="m-0 text-heading-20 font-semibold">{selected.title}</h3>
              <Link
                href={withQuery(path, search, { full: "1" }) as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("places.kit.openFull")}
              </Link>
            </div>
            {detail(selected)}
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
    body = (
      <CollectionEmpty
        icon="MapPin"
        sentence={t("places.documents.noVenues")}
        actionLabel={t("places.venues.create")}
        href={`${nodeHref("places.venues", params) ?? "/"}?create=1`}
      />
    );
  } else if (documents.data.length === 0) {
    body = canWrite ? (
      <CollectionEmpty
        icon="FileText"
        sentence={t("places.documents.empty")}
        actionLabel={t("places.documents.create")}
        href={withQuery(path, search, { create: "1" })}
      />
    ) : (
      <InlineAlert tone="info">{t("places.documents.emptyReadOnly")}</InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("places.documents.title")}
        pinStart={["title"]}
        columns={[
          { key: "title", label: t("places.documents.fields.title") },
          { key: "venue", label: t("places.documents.fields.venue") },
          { key: "from", label: t("places.documents.fields.validFrom") },
          { key: "to", label: t("places.documents.fields.validTo") },
          { key: "validity", label: t("places.documents.validity") },
          { key: "frozen", label: t("places.documents.frozen") },
        ]}
        rows={rows.map((d) => ({
          id: d.id,
          title: d.title,
          venue: venueById.get(d.venueId)?.name ?? null,
          from: day(d.validFrom),
          to: day(d.validTo),
          validity: t(`places.documents.state.${validityOf(d)}`),
          frozen: d.frozen ? t("places.documents.frozenYes") : t("places.documents.frozenNo"),
        }))}
      />
    );
  } else {
    body = (
      <EntityList
        label={t("places.documents.title")}
        path={path}
        search={search}
        rows={rows.map((d) => ({
          id: d.id,
          title: d.title,
          meta: [
            venueById.get(d.venueId)?.name,
            t("places.documents.window", { from: day(d.validFrom), to: day(d.validTo) }),
          ]
            .filter(Boolean)
            .join(" · "),
          chips: (
            <>
              <Tag tone={VALIDITY_TONE[validityOf(d)]}>
                {t(`places.documents.state.${validityOf(d)}`)}
              </Tag>
              {d.frozen ? <Tag>{t("places.documents.frozen")}</Tag> : null}
              {d.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
            </>
          ),
        }))}
      />
    );
  }

  return (
    <Collection
      title={t("places.documents.title")}
      count={rows.length}
      views={views}
      primary={
        canWrite && venueOptions.length > 0 ? (
          <CreateLink path={path} search={search} label={t("places.documents.create")} />
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("places.documents.search")} />
          <LinkFilter
            path={path}
            search={search}
            label={t("places.documents.fields.venue")}
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
