import { listSubmissions, type SubmissionFilter } from "@xos/data/advancing";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { PeekHandoff } from "@/components/shell/peek-handoff";
import { EmptyStateLink } from "@/components/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { RecordCollab } from "./record-collab";
import { ReviewForm } from "./forms";
import { isRowId, partyLabel, withQuery, type Search } from "./shared";
import { PageHeader, Tag, TemplateSplitView } from "./ui";
import { SelectFilter } from "./views";
import { CollectionPage } from "@/components/platform/collection-page";

const FILTERS: readonly SubmissionFilter[] = ["unreviewed", "reviewed", "all"];

/**
 * Submissions (Section 4.5.5, Split view template in Section 11.6): the review queue on the left,
 * the selected answer on the right with its packet, section, recipient and review. The queue holds
 * each recipient's latest unreviewed answer; Reviewed and All show history.
 */
export async function SubmissionsSplit({
  actx,
  path,
  search,
  title,
  packetsHref,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
  packetsHref: string;
}) {
  const { ctx, can, projects, project } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const review = FILTERS.find((f) => f === search["filter"]) ?? "unreviewed";
  const result = await listSubmissions(ctx.viewer.db, {
    orgId: ctx.org.id,
    review,
    ...(project ? { projectId: project.id } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list submissions: ${JSON.stringify(result.error)}`);
  const items = result.data;
  const peekId = search["peek"];
  // A reviewed answer leaves the queue, so an id it no longer holds falls back to its first answer;
  // a key that is no submission id at all (a record key from elsewhere) goes to the shell's peek.
  const selected = items.find((s) => s.id === peekId) ?? items[0];
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const projectKey = (id: string) => projects.find((p) => p.id === id)?.key ?? "";
  const fixedProject = actx.project !== null && search["project"] === undefined;

  return (
    <CollectionPage gap={12} header={<PageHeader title={title} count={items.length} />}>
      <div className="flex flex-wrap items-end gap-8">
        {fixedProject ? null : (
          <SelectFilter
            id="submissions-project"
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
          id="submissions-review"
          label={t("advancing.submissions.filter")}
          param="filter"
          value={review}
          options={FILTERS.map((f) => ({
            value: f,
            label: t(`advancing.submissions.filters.${f}`),
          }))}
        />
      </div>
      {!selected ? (
        <EmptyStateLink
          icon="Inbox"
          sentence={t(`advancing.submissions.empty.${review}`)}
          actionLabel={t("advancing.submissions.viewPackets")}
          href={packetsHref}
        />
      ) : (
        <TemplateSplitView
          listLabel={t("advancing.submissions.queue")}
          list={
            <ul
              aria-label={t("advancing.submissions.queue")}
              className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
            >
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    href={withQuery(path, search, { peek: s.id }) as Route}
                    aria-current={s.id === selected.id ? "true" : undefined}
                    className="flex flex-col gap-2 px-12 py-8 hover:bg-bg-hover focus-visible:bg-bg-hover aria-[current=true]:bg-bg-hover"
                  >
                    <span className="truncate text-label-13 font-medium text-text-primary">
                      {s.sectionTitle}
                    </span>
                    <span className="truncate text-text-12 text-text-secondary">
                      {partyLabel(s.recipient, t)} · {projectKey(s.projectId)} · {s.packetTitle}
                    </span>
                    <span className="text-text-12 text-text-tertiary">{when(s.submittedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          }
          detail={
            <article aria-labelledby="submission-title" className="flex flex-col gap-12">
              <div className="flex flex-wrap items-center gap-8">
                <h2 id="submission-title" className="m-0 text-heading-16 font-semibold">
                  {selected.sectionTitle}
                </h2>
                {selected.viaLink ? (
                  <Tag tone="accent">{t("advancing.answers.viaLink")}</Tag>
                ) : null}
                {selected.reviewOutcome ? (
                  <Tag tone={selected.reviewOutcome === "Accepted" ? "success" : "warning"}>
                    {t(`advancing.review.outcomes.${selected.reviewOutcome}`)}
                  </Tag>
                ) : (
                  <Tag>{t("advancing.review.awaiting")}</Tag>
                )}
              </div>
              <p className="m-0 text-text-13 text-text-secondary">
                {t("advancing.submissions.from", {
                  name: partyLabel(selected.recipient, t),
                  date: when(selected.submittedAt),
                })}
              </p>
              {selected.sectionPrompt ? (
                <p className="m-0 text-text-13 text-text-secondary">{selected.sectionPrompt}</p>
              ) : null}
              <p className="m-0 whitespace-pre-wrap rounded-card border border-border-subtle p-12 text-text-14">
                {selected.body}
              </p>
              {selected.returnReason ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("advancing.review.returnedBecause", { reason: selected.returnReason })}
                </p>
              ) : null}
              {!selected.latest ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("advancing.submissions.superseded")}
                </p>
              ) : null}
              {can.review && selected.reviewedAt === null ? (
                <ReviewForm org={ctx.org.slug} submissionId={selected.id} />
              ) : null}
              {!can.review && selected.reviewedAt === null ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {t("advancing.review.needsAuthority")}
                </p>
              ) : null}
              <Link
                href={`${packetsHref}?peek=${selected.packetId}&full=1` as Route}
                className="self-start text-text-13 text-accent-text hover:underline"
              >
                {t("advancing.submissions.openPacket", { title: selected.packetTitle })}
              </Link>
              <RecordCollab
                actx={actx}
                table="app.advance_submissions"
                id={selected.id}
                canUpload={can.review}
              />
            </article>
          }
        />
      )}
      {peekId && !isRowId(peekId) ? <PeekHandoff recordKey={peekId} /> : null}
    </CollectionPage>
  );
}
