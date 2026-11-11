"use client";

import type { Route } from "next";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { useCopy } from "./action-ui";

/** A record as its related records name it: key, title, kind and state. */
export interface RelatedRecord {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly state: string;
}

/** A dependency seen from the record: its type and the record at its other end, null when hidden. */
export interface RelatedDependency {
  readonly id: string;
  readonly type: string;
  readonly record: RelatedRecord | null;
}

/** A custom object record that links to the record (custom_object_relations, Section 4.6.3). */
export interface RelatedLink {
  readonly id: string;
  readonly relationKey: string;
  readonly objectKey: string;
  readonly objectLabel: string;
  readonly recordId: string;
  readonly title: string;
}

/**
 * A record's related records (Section 11.2 item 4): the summary record it rolls up to, its
 * sub-records, the records it waits on and holds up, and the custom object records linked to it.
 */
export interface RecordRelations {
  readonly parent: RelatedRecord | null;
  /** The record has a parent the viewer cannot read. */
  readonly parentHidden: boolean;
  readonly children: readonly RelatedRecord[];
  readonly waitsOn: readonly RelatedDependency[];
  readonly holdsUp: readonly RelatedDependency[];
  readonly links: readonly RelatedLink[];
}

/**
 * The related records section, the same in the record's side peeks and on its full page (Record
 * template). Each record links to its full page and each custom object record to its peek. Where the
 * viewer may change dependencies, `dependencies` is the dependency editor, which lists them itself.
 */
export function RelatedRecords({
  org,
  recordId,
  relations,
  dependencies,
}: {
  org: string;
  recordId: string;
  relations: RecordRelations;
  dependencies?: ReactNode;
}) {
  const t = useCopy("work");
  const s = useCopy("schedule");
  const { parent, parentHidden, children, waitsOn, holdsUp, links } = relations;
  const nothing =
    parent === null &&
    !parentHidden &&
    children.length === 0 &&
    waitsOn.length === 0 &&
    holdsUp.length === 0 &&
    links.length === 0;
  const record = (r: RelatedRecord | null) =>
    r ? (
      <NextLink
        href={`/${org}/r/${encodeURIComponent(r.key)}` as Route}
        className="text-accent-text no-underline hover:underline"
      >
        <span className="font-mono text-text-12">{r.key}</span> {r.title}
      </NextLink>
    ) : (
      <span className="text-text-secondary">{s("dependencies.hidden")}</span>
    );
  const group = (id: string, title: string, items: ReactNode[]) =>
    items.length === 0 ? null : (
      <div className="flex flex-col gap-4">
        <h3 id={`${id}-${recordId}`} className="m-0 text-label-13 font-semibold">
          {title}
        </h3>
        <ul aria-labelledby={`${id}-${recordId}`} className="m-0 flex list-none flex-col gap-4 p-0">
          {items}
        </ul>
      </div>
    );
  const row = (key: string, content: ReactNode, note?: string) => (
    <li key={key} className="text-text-13">
      {content}
      {note ? <span className="text-text-secondary"> · {note}</span> : null}
    </li>
  );
  const dependency = (d: RelatedDependency) =>
    row(d.id, record(d.record), s(`dependencies.types.${d.type}`));
  return (
    <section aria-labelledby={`related-${recordId}`} className="flex flex-col gap-12">
      <h2 id={`related-${recordId}`} className="m-0 text-heading-16 font-semibold">
        {t("related.title")}
      </h2>
      {nothing && !dependencies ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("related.none")}</p>
      ) : null}
      {group(
        "related-parent",
        t("related.parent"),
        parent || parentHidden ? [row("parent", record(parent))] : [],
      )}
      {group(
        "related-children",
        t("related.children"),
        children.map((c) => row(c.id, record(c), t(`states.${c.state}`))),
      )}
      {dependencies ?? (
        <>
          {group("related-waits-on", s("dependencies.before"), waitsOn.map(dependency))}
          {group("related-holds-up", s("dependencies.after"), holdsUp.map(dependency))}
        </>
      )}
      {group(
        "related-links",
        t("related.links"),
        links.map((l) =>
          row(
            l.id,
            <NextLink
              href={`/${org}/objects/${l.objectKey}?peek=${l.recordId}` as Route}
              className="text-accent-text no-underline hover:underline"
            >
              {l.objectLabel} · {l.title}
            </NextLink>,
            l.relationKey.replaceAll("_", " "),
          ),
        ),
      )}
    </section>
  );
}
