import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { personNames, type TransitionEntry } from "@xos/data/crew";
import type { RecordState } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { RecordHistory } from "@/components/history/record-history";
import type { CrewContext } from "@/lib/crew/context";
import { getTranslate } from "@/lib/shell/translate";
import { PropertyList, StateChip, TemplateRecord } from "./ui";
// A record renders in a peek or its own page, not with a list (A24-009).
import { CrewCollab, PeekPanel } from "./lazy";

/**
 * The one record anatomy (Section 11.2, rule 4) for People and Crew entities, in the side peek and on
 * the full page (`?peek=<id>&full=1`, ADR on domain entity pages): title, kind and state, the actions
 * the viewer may take, the property column, the state history and the comment thread.
 */

export interface RecordProps {
  readonly crew: CrewContext;
  readonly mode: "peek" | "full";
  readonly kindLabel: string;
  readonly recordKey: string;
  readonly title: string;
  readonly state: RecordState;
  readonly stateLabel: string;
  readonly properties: ReadonlyArray<{ label: string; value: ReactNode }>;
  readonly actions?: ReactNode;
  readonly history?: readonly TransitionEntry[];
  /** Translates a stored state value of this lifecycle for the history list. */
  readonly stateName?: (value: string) => string;
  readonly children?: ReactNode;
  /** The list URL the full page returns to. */
  readonly backHref: string;
  /** The commentable row (a table in private.comment_subjects); omitted for ledgers without one. */
  readonly subject?: { readonly table: string; readonly id: string };
}

async function History(props: {
  crew: CrewContext;
  history: readonly TransitionEntry[];
  stateName: (value: string) => string;
}) {
  const t = await getTranslate();
  const format = await getFormatter();
  const names = await personNames(
    props.crew.ctx.viewer.db,
    props.history.map((h) => h.by),
  );
  const nameOf = (id: string | null) =>
    id === null
      ? t("crew.record.system")
      : ((names.ok ? names.data.get(id) : null) ?? t("crew.record.someone"));
  return (
    <section aria-labelledby="record-history" className="flex flex-col gap-8">
      <h2 id="record-history" className="m-0 text-text-13 font-semibold">
        {t("crew.record.history")}
      </h2>
      <ol className="m-0 flex list-none flex-col gap-8 p-0">
        {[...props.history].reverse().map((h) => (
          <li key={h.id} className="flex flex-col gap-2 border-s border-border-subtle ps-12">
            <span className="text-text-13">
              {h.fromState === null
                ? t("crew.record.created", { state: props.stateName(h.toState) })
                : t("crew.record.moved", {
                    from: props.stateName(h.fromState),
                    to: props.stateName(h.toState),
                  })}
            </span>
            <span className="text-text-12 text-text-secondary">{h.reason}</span>
            <span className="text-text-12 text-text-tertiary">
              {t("crew.record.byAt", {
                name: nameOf(h.by),
                at: format.dateTime(new Date(h.at), { dateStyle: "medium", timeStyle: "short" }),
              })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The field history (A131), comment thread and attachments of the record (A18's unified comment and
 * attachment services).
 */
async function Conversation(props: { crew: CrewContext; subject: { table: string; id: string } }) {
  const db = props.crew.ctx.viewer.db;
  const [threads, attachments] = await Promise.all([
    listThreads(db, props.subject),
    listAttachments(db, props.subject),
  ]);
  if (!threads.ok) throw new Error(`Cannot read comments: ${threads.error.kind}`);
  if (!attachments.ok) throw new Error(`Cannot read attachments: ${attachments.error.kind}`);
  const authors = threads.data.flatMap((th) => th.comments.map((c) => c.authorPersonId));
  const names = await personNames(db, authors);
  return (
    <>
      <RecordHistory db={db} table={props.subject.table} id={props.subject.id} />
      <CrewCollab
        org={props.crew.slug}
        table={props.subject.table}
        id={props.subject.id}
        threads={threads.data}
        attachments={attachments.data}
        names={Object.fromEntries(
          [...(names.ok ? names.data : new Map<string, string | null>())].flatMap(([k, v]) =>
            v ? [[k, v]] : [],
          ),
        )}
        me={props.crew.ctx.viewer.person?.id ?? null}
      />
    </>
  );
}

export async function CrewRecord(props: RecordProps) {
  const t = await getTranslate();
  const stateName = props.stateName ?? ((v: string) => v);
  const history =
    props.history && props.history.length > 0 ? (
      <History crew={props.crew} history={props.history} stateName={stateName} />
    ) : null;

  if (props.mode === "peek") {
    return (
      <PeekPanel
        kindLabel={props.kindLabel}
        recordKey={props.recordKey}
        title={props.title}
        state={props.state}
        stateLabel={props.stateLabel}
      >
        {props.actions ? <div className="flex flex-wrap gap-8">{props.actions}</div> : null}
        <PropertyList items={[...props.properties]} />
        {props.children}
        {history}
        {props.subject ? <Conversation crew={props.crew} subject={props.subject} /> : null}
      </PeekPanel>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <Link
        href={props.backHref as Route}
        className="text-text-12 text-text-secondary hover:text-text-primary"
      >
        {t("crew.record.back")}
      </Link>
      <TemplateRecord
        propertiesLabel={t("crew.record.properties")}
        header={
          <header className="flex flex-col gap-8">
            <span className="flex items-center gap-6 text-text-12 text-text-secondary">
              <span>{props.kindLabel}</span>
              <span className="font-mono">{props.recordKey}</span>
            </span>
            <h1 className="m-0 text-heading-24 font-semibold">{props.title}</h1>
            <div className="flex flex-wrap items-center gap-8">
              <StateChip state={props.state} label={props.stateLabel} />
              {props.actions}
            </div>
          </header>
        }
        properties={<PropertyList items={[...props.properties]} />}
      >
        {props.children}
        {history}
        {props.subject ? <Conversation crew={props.crew} subject={props.subject} /> : null}
      </TemplateRecord>
    </div>
  );
}
