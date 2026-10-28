import {
  getPacket,
  linkStatus,
  listAdvanceLinks,
  listAdvanceParties,
  listPackets,
  PACKET_STATES,
  type PacketDetail,
  type PacketState,
  type PacketSummary,
} from "@xos/data/advancing";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { collectionPeek } from "@/components/shell/collection-peek";
import { EmptyStateLink } from "@/components/ui";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { RecordCollab } from "./record-collab";
import {
  AddRecipientForm,
  ArchivePacketButton,
  CreatePacketDialog,
  IssueLinkForm,
  PacketDetailsForm,
  Panel,
  RecordAnswerForm,
  RemoveRecipientButton,
  ReviewForm,
  RevokeLinkButton,
  SectionList,
  SendPacketButton,
} from "./forms";
import {
  isRowId,
  PACKET_RECORD_STATE,
  partyLabel,
  pickView,
  Property,
  withQuery,
  type Search,
} from "./shared";
import { PageHeader, ProgressBar, StateChip, Tag, TemplateRecord } from "./ui";
import { PeekBoard, PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS = ["list", "table", "board"] as const;

/**
 * Packets (Section 4.5.5): the Collection template with list, table and board views over the
 * derived packet state, a side peek (`?peek=`) and the Record template full page (`&full=1`).
 * Used at org level with a project filter and inside the project tab, with the same component.
 */
export async function PacketsCollection({
  actx,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx, can, projects, project } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const peekId = search["peek"];

  if (peekId && search["full"] === "1") {
    return (
      <PacketPage
        actx={actx}
        packetId={peekId}
        backHref={withQuery(path, search, { peek: null, full: null })}
      />
    );
  }

  const result = await listPackets(db, {
    orgId: ctx.org.id,
    ...(project ? { projectId: project.id } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list packets: ${JSON.stringify(result.error)}`);
  const stateFilter = PACKET_STATES.find((s) => s === search["filter"]);
  const packets = stateFilter ? result.data.filter((p) => p.state === stateFilter) : result.data;
  const view = pickView(search, VIEWS, "list");
  const projectKey = (id: string) => projects.find((p) => p.id === id)?.key ?? "";
  const stateLabel = (s: PacketState) => t(`advancing.states.${s}`);
  const due = (p: PacketSummary) =>
    p.dueAt
      ? format.dateTime(new Date(p.dueAt), { dateStyle: "medium" })
      : t("advancing.common.noDue");
  const progress = (p: PacketSummary) =>
    t("advancing.packets.progress", {
      answered: p.progress.answered,
      expected: p.progress.expected,
    });
  const fixedProject = actx.project !== null && search["project"] === undefined;

  // A key that is no packet id (a record key from elsewhere) goes to the shell's peek; an id
  // with no packet here answers 404 (loadPacket).
  const peek = collectionPeek(
    peekId,
    peekId && isRowId(peekId) ? await PacketPeek({ actx, packetId: peekId }) : null,
  );

  return (
    <CollectionPage
      gap={12}
      header={
        <PageHeader
          title={title}
          count={packets.length}
          views={<ViewSwitcher views={VIEWS} current={view} />}
          {...(can.write && projects.length > 0
            ? {
                actions: (
                  <CreatePacketDialog
                    org={ctx.org.slug}
                    projects={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
                    defaultProjectId={project?.id ?? null}
                    defaultOpen={search["create"] === "1"}
                  />
                ),
              }
            : {})}
        />
      }
    >
      <div className="flex flex-wrap items-end gap-8">
        {fixedProject ? null : (
          <SelectFilter
            id="packets-project"
            label={t("advancing.common.project")}
            param="project"
            value={project?.key ?? ""}
            options={[
              { value: "", label: t("advancing.common.allProjects") },
              ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
            ]}
          />
        )}
        <SelectFilter
          id="packets-state"
          label={t("advancing.common.state")}
          param="filter"
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("advancing.common.allStates") },
            ...PACKET_STATES.map((s) => ({ value: s, label: stateLabel(s) })),
          ]}
        />
      </div>
      {!can.write ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("advancing.packets.readOnly")}</p>
      ) : null}
      {packets.length === 0 ? (
        stateFilter ? (
          <EmptyStateLink
            icon="Filter"
            sentence={t("advancing.packets.emptyFiltered", { state: stateLabel(stateFilter) })}
            actionLabel={t("advancing.common.clearFilter")}
            href={withQuery(path, search, { filter: null })}
          />
        ) : (
          <EmptyStateLink
            icon="Send"
            sentence={
              projects.length === 0
                ? t("advancing.packets.emptyNoProjects")
                : can.write
                  ? t("advancing.packets.empty")
                  : t("advancing.packets.emptyReadOnly")
            }
            actionLabel={
              projects.length === 0
                ? t("advancing.common.viewProjects")
                : t("advancing.packets.create.open")
            }
            href={
              projects.length === 0
                ? `/${ctx.org.slug}/projects/all`
                : withQuery(path, search, { create: "1" })
            }
          />
        )
      ) : view === "table" ? (
        <PeekTable
          caption={title}
          columns={[
            { key: "title", label: t("advancing.packets.columns.title"), wrap: true },
            { key: "project", label: t("advancing.common.project"), type: "code" },
            { key: "state", label: t("advancing.common.state") },
            { key: "due", label: t("advancing.packets.columns.due") },
            { key: "recipients", label: t("advancing.packets.columns.recipients"), type: "number" },
            { key: "progress", label: t("advancing.packets.columns.progress") },
          ]}
          rows={packets.map((p) => ({
            id: p.id,
            label: p.title,
            title: p.title,
            project: projectKey(p.projectId),
            state: stateLabel(p.state),
            due: due(p),
            recipients: p.recipientCount,
            progress: progress(p),
          }))}
        />
      ) : view === "board" ? (
        <PeekBoard
          columns={PACKET_STATES.map((s) => ({
            state: PACKET_RECORD_STATE[s],
            label: stateLabel(s),
            cards: packets
              .filter((p) => p.state === s)
              .map((p) => ({
                key: p.id,
                title: p.title,
                meta: `${projectKey(p.projectId)} · ${progress(p)}`,
                due: due(p),
              })),
          }))}
        />
      ) : (
        <ul
          aria-label={title}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {packets.map((p) => (
            <li key={p.id}>
              <Link
                href={withQuery(path, search, { peek: p.id, full: null }) as Route}
                className="flex min-h-row-comfortable flex-wrap items-center gap-12 px-16 py-8 hover:bg-bg-hover focus-visible:bg-bg-hover"
              >
                <StateChip
                  state={PACKET_RECORD_STATE[p.state]}
                  label={stateLabel(p.state)}
                  compact
                />
                <span className="font-mono text-text-12 text-text-secondary">
                  {projectKey(p.projectId)}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-14 text-text-primary">
                  {p.title}
                </span>
                <span className="text-text-12 text-text-secondary">{progress(p)}</span>
                <span className="text-text-12 text-text-secondary">{due(p)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {peek}
    </CollectionPage>
  );
}

async function loadPacket(actx: AdvancingContext, packetId: string): Promise<PacketDetail> {
  const result = await getPacket(actx.ctx.viewer.db, packetId);
  if (!result.ok) {
    if (peekRowMissing(result.error)) notFound();
    throw new Error(`Cannot read packet: ${JSON.stringify(result.error)}`);
  }
  if (actx.project && result.data.projectId !== actx.project.id) notFound();
  return result.data;
}

async function PacketPeek({ actx, packetId }: { actx: AdvancingContext; packetId: string }) {
  const packet = await loadPacket(actx, packetId);
  const t = await getTranslate();
  const format = await getFormatter();
  const project = actx.projects.find((p) => p.id === packet.projectId);
  return (
    <PeekPanel
      title={packet.title}
      state={PACKET_RECORD_STATE[packet.state]}
      stateLabel={t(`advancing.states.${packet.state}`)}
      properties={[
        {
          label: t("advancing.common.project"),
          value: project ? `${project.key} · ${project.name}` : "",
        },
        {
          label: t("advancing.packets.columns.due"),
          value: packet.dueAt
            ? format.dateTime(new Date(packet.dueAt), { dateStyle: "medium", timeStyle: "short" })
            : t("advancing.common.noDue"),
        },
        {
          label: t("advancing.packets.columns.recipients"),
          value:
            packet.recipients.map((r) => partyLabel(r.party, t)).join(", ") ||
            t("advancing.recipients.none"),
        },
        {
          label: t("advancing.packets.columns.progress"),
          value: t("advancing.packets.progress", {
            answered: packet.progress.answered,
            expected: packet.progress.expected,
          }),
        },
      ]}
    >
      <ol className="m-0 flex flex-col gap-4 ps-20 text-text-13">
        {packet.sections.map((s) => (
          <li key={s.id}>{s.title}</li>
        ))}
      </ol>
    </PeekPanel>
  );
}

/** The packet's full page: Record template with content and activity beside its properties. */
async function PacketPage({
  actx,
  packetId,
  backHref,
}: {
  actx: AdvancingContext;
  packetId: string;
  backHref: string;
}) {
  const { ctx, can } = actx;
  const packet = await loadPacket(actx, packetId);
  const t = await getTranslate();
  const format = await getFormatter();
  const org = ctx.org.slug;
  const sent = packet.sentAt !== null;
  const [parties, links] = await Promise.all([
    can.write ? listAdvanceParties(ctx.viewer.db, ctx.org.id) : Promise.resolve(null),
    can.send && sent
      ? listAdvanceLinks(
          ctx.viewer.db,
          packet.recipients.map((r) => r.id),
        )
      : Promise.resolve(null),
  ]);
  if (parties && !parties.ok)
    throw new Error(`Cannot list parties: ${JSON.stringify(parties.error)}`);
  if (links && !links.ok) throw new Error(`Cannot list links: ${JSON.stringify(links.error)}`);
  const project = actx.projects.find((p) => p.id === packet.projectId);
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : null;
  const taken = new Set(packet.recipients.map((r) => `${r.party.kind}:${r.party.id}`));
  const partyOptions = (parties?.ok ? parties.data : [])
    .filter((p) => !taken.has(`${p.kind}:${p.id}`))
    .map((p) => ({
      value: `${p.kind}:${p.id}`,
      label: `${partyLabel(p, t)} · ${t(p.kind === "person" ? "advancing.common.person" : "advancing.common.counterparty")}`,
    }));
  const latest = packet.submissions.filter((s) => s.latest);
  const recipientName = (id: string) => {
    const r = packet.recipients.find((x) => x.id === id);
    return r ? partyLabel(r.party, t) : t("advancing.recipients.removed");
  };

  return (
    <TemplateRecord
      propertiesLabel={t("advancing.common.properties")}
      header={
        <div className="flex flex-col gap-8">
          <Link
            href={backHref as Route}
            className="text-text-13 text-text-secondary hover:text-text-primary"
          >
            {t("advancing.packets.back")}
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-12">
            <div className="flex flex-wrap items-center gap-8">
              {project ? <Tag>{project.key}</Tag> : null}
              <h1 className="m-0 text-heading-20 font-semibold">{packet.title}</h1>
              <StateChip
                state={PACKET_RECORD_STATE[packet.state]}
                label={t(`advancing.states.${packet.state}`)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-8">
              {!sent && can.send ? (
                <SendPacketButton
                  org={org}
                  packetId={packet.id}
                  title={packet.title}
                  recipients={packet.recipients.length}
                />
              ) : null}
              {can.write ? (
                <ArchivePacketButton
                  org={org}
                  packetId={packet.id}
                  title={packet.title}
                  backHref={backHref}
                />
              ) : null}
            </div>
          </div>
          {!sent && !can.send && can.write ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("advancing.packets.send.needsAuthority")}
            </p>
          ) : null}
        </div>
      }
      properties={
        <dl className="m-0 flex flex-col">
          <Property label={t("advancing.common.project")}>
            {project ? `${project.key} · ${project.name}` : ""}
          </Property>
          <Property label={t("advancing.common.state")}>
            {t(`advancing.states.${packet.state}`)}
          </Property>
          <Property label={t("advancing.packets.columns.due")}>
            {when(packet.dueAt) ?? t("advancing.common.noDue")}
          </Property>
          <Property label={t("advancing.packets.sentAt")}>
            {when(packet.sentAt) ?? t("advancing.packets.notSent")}
          </Property>
          <Property label={t("advancing.common.created")}>{when(packet.createdAt)}</Property>
          <Property label={t("advancing.packets.columns.progress")}>
            <ProgressBar
              label={t("advancing.packets.progress", {
                answered: packet.progress.answered,
                expected: packet.progress.expected,
              })}
              value={
                packet.progress.expected === 0
                  ? 0
                  : Math.round((packet.progress.answered / packet.progress.expected) * 100)
              }
            />
            <span className="text-text-12 text-text-secondary">
              {t("advancing.packets.reviewed", {
                reviewed: packet.progress.reviewed,
                expected: packet.progress.expected,
              })}
            </span>
          </Property>
        </dl>
      }
    >
      <Panel id="packet-details" title={t("advancing.packets.details.title")}>
        <PacketDetailsForm
          org={org}
          packetId={packet.id}
          title={packet.title}
          dueAt={packet.dueAt}
          disabled={!can.write}
        />
      </Panel>
      <Panel id="packet-sections" title={t("advancing.sections.title")}>
        <SectionList
          org={org}
          packetId={packet.id}
          sections={packet.sections}
          canEdit={can.write}
          sent={sent}
          draftContext={[
            { collection: "advance-packets", id: packet.id, label: packet.title },
            ...(project
              ? [
                  {
                    collection: "projects",
                    id: project.id,
                    label: `${project.key} · ${project.name}`,
                  },
                ]
              : []),
          ]}
        />
      </Panel>
      <Panel id="packet-recipients" title={t("advancing.recipients.title")}>
        {packet.recipients.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {can.write ? t("advancing.recipients.emptyEditable") : t("advancing.recipients.none")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
            {packet.recipients.map((r) => {
              const name = partyLabel(r.party, t);
              const own = (links?.ok ? links.data : []).filter((l) => l.recipientId === r.id);
              return (
                <li key={r.id} className="flex flex-col gap-8 p-12">
                  <div className="flex items-center justify-between gap-8">
                    <span className="text-label-13 font-medium">{name}</span>
                    {can.write ? (
                      <RemoveRecipientButton org={org} recipientId={r.id} name={name} />
                    ) : null}
                  </div>
                  {own.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12 text-text-secondary">
                      {own.map((l) => (
                        <li key={l.id} className="flex flex-wrap items-center gap-8">
                          <span>
                            {t(`advancing.links.status.${linkStatus(l)}`)} · {l.recipientEmail} ·{" "}
                            {t("advancing.links.expires", { date: when(l.expiresAt) ?? "" })}
                          </span>
                          {linkStatus(l) === "Live" || linkStatus(l) === "Used" ? (
                            <RevokeLinkButton org={org} linkId={l.id} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {can.send && sent ? (
                    <IssueLinkForm org={org} recipientId={r.id} name={name} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {can.write ? (
          <AddRecipientForm org={org} packetId={packet.id} parties={partyOptions} />
        ) : null}
        {can.send && !sent && packet.recipients.length > 0 ? (
          <p className="m-0 text-text-12 text-text-tertiary">{t("advancing.links.afterSend")}</p>
        ) : null}
      </Panel>
      <Panel id="packet-answers" title={t("advancing.answers.title")}>
        {!sent ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("advancing.answers.unsent")}</p>
        ) : latest.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("advancing.answers.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-12 p-0">
            {latest.map((s) => {
              const section = packet.sections.find((x) => x.id === s.sectionId);
              return (
                <li
                  key={s.id}
                  className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
                >
                  <div className="flex flex-wrap items-center gap-8 text-text-12 text-text-secondary">
                    <span className="text-label-13 font-medium text-text-primary">
                      {section?.title ?? t("advancing.answers.removedSection")}
                    </span>
                    <span>{recipientName(s.recipientId)}</span>
                    <span>{when(s.submittedAt)}</span>
                    {s.viaLink ? <Tag tone="accent">{t("advancing.answers.viaLink")}</Tag> : null}
                    {s.reviewOutcome ? (
                      <Tag tone={s.reviewOutcome === "Accepted" ? "success" : "warning"}>
                        {t(`advancing.review.outcomes.${s.reviewOutcome}`)}
                      </Tag>
                    ) : null}
                  </div>
                  <p className="m-0 whitespace-pre-wrap text-text-14">{s.body}</p>
                  {s.returnReason ? (
                    <p className="m-0 text-text-13 text-text-secondary">
                      {t("advancing.review.returnedBecause", { reason: s.returnReason })}
                    </p>
                  ) : null}
                  {can.review && s.reviewedAt === null ? (
                    <ReviewForm org={org} submissionId={s.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {sent && can.review && packet.sections.length > 0 && packet.recipients.length > 0 ? (
          <details className="rounded-card border border-border-subtle p-12">
            <summary className="cursor-pointer text-label-13 font-medium">
              {t("advancing.record.title")}
            </summary>
            <div className="pt-12">
              <RecordAnswerForm
                org={org}
                sections={packet.sections.map((s) => ({ value: s.id, label: s.title }))}
                recipients={packet.recipients.map((r) => ({
                  value: r.id,
                  label: partyLabel(r.party, t),
                }))}
              />
            </div>
          </details>
        ) : null}
      </Panel>
      <RecordCollab actx={actx} table="app.advance_packets" id={packet.id} canUpload={can.write} />
    </TemplateRecord>
  );
}
