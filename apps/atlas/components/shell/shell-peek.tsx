"use client";

import { Button, InlineAlert } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { withQuery } from "@/components/work/format";
import { loadShellPeekAction, type ShellPeekResult } from "@/lib/shell/peek-actions";
import { shellOpensPeek } from "@/lib/shell/peek";
import { peekHandoffs, serverPeekHandoffs, subscribePeekHandoffs } from "@/lib/shell/peek-handoff";
import { onDemand, useOnDemand } from "./on-demand";

/** The side peek and its sections load with the first record the shell opens (A24-009). */
const peek = onDemand(() => import("./shell-peek-sections"));

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The shell's global `?peek={recordKey}` hook: on every Atlas route that does not peek its own rows,
 * the record the key names opens in the side peek, with the sections of its full page (properties,
 * recent activity, comments and files, related records); on a collection page it opens only a key
 * the page hands over because it shows no row for it (PeekHandoff), never on the collection's full
 * record page (`&full=1`); closing it removes the parameter. Aurora citation links and proposed
 * sitemap nodes rely on it (see lib/shell/peek.ts).
 */
export function ShellPeek({ org }: { org: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const t = useTranslations("peek") as unknown as Translate;
  const work = useTranslations("work") as unknown as Translate & { has: (k: string) => boolean };
  const projects = useTranslations("projects") as unknown as Translate & {
    has: (k: string) => boolean;
  };
  const key = search.get("peek");
  // A collection page owns `?peek` however long its own panel takes to load, and says so explicitly
  // when it cannot show the key; the shell never guesses from what is on screen.
  const handoffs = useSyncExternalStore(subscribePeekHandoffs, peekHandoffs, serverPeekHandoffs);
  const active = shellOpensPeek(pathname, search, handoffs);
  const [result, setResult] = useState<{ key: string; value: ShellPeekResult } | null>(null);
  // Bumped after a comment or file changes, to read the record again.
  const [version, setVersion] = useState(0);
  const loaded = useOnDemand(peek, active);

  useEffect(() => {
    if (!active || key === null) return;
    let live = true;
    loadShellPeekAction(org, key).then(
      (value) => {
        if (live) setResult({ key, value });
      },
      (error: unknown) => {
        console.error("Shell peek failed", error);
        if (live) setResult({ key, value: { ok: false, reason: "unexpected" } });
      },
    );
    return () => {
      live = false;
    };
  }, [active, key, org, version]);

  if (!active || key === null) return null;
  const close = () =>
    router.replace(withQuery(pathname, search, { peek: null }) as Route, { scroll: false });
  const current = result?.key === key ? result.value : null;
  if (current === null || (current.ok && loaded === null)) {
    return (
      <p role="status" className="sr-only" data-testid="shell-peek-loading">
        {t("loading", { key })}
      </p>
    );
  }
  if (!current.ok) {
    return (
      <div
        data-testid="shell-peek-missing"
        className="fixed bottom-24 end-24 z-peek flex max-w-layout-form flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16 shadow-menu"
      >
        <InlineAlert tone={current.reason === "notFound" ? "warning" : "danger"}>
          {current.reason === "notFound" ? t("missing", { key }) : t("unexpected", { key })}
        </InlineAlert>
        <div>
          <Button size="sm" variant="secondary" onClick={close}>
            {t("close")}
          </Button>
        </div>
      </div>
    );
  }
  const r = current.record;
  const stamp = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(r.timeZone ? { timeZone: r.timeZone } : {}),
    }).format(new Date(iso));
  const stateName = (state: string) =>
    work.has(`states.${state}`) ? work(`states.${state}`) : state;
  // The record's key properties, as on its full page (Section 11.2 item 4, A59-016).
  const properties = [
    { label: t("project"), value: `${r.projectKey} · ${r.projectName}` },
    { label: t("owner"), value: r.ownerName ?? t("unassigned") },
    ...(r.phaseCode && projects.has(`phases.${r.phaseCode}`)
      ? [{ label: t("phase"), value: projects(`phases.${r.phaseCode}`) }]
      : []),
    ...(r.startsAt
      ? [
          {
            label: t("starts"),
            value: r.startTbc
              ? work("values.tbcEstimate", { time: stamp(r.startsAt) })
              : stamp(r.startsAt),
          },
        ]
      : []),
    ...(r.endsAt ? [{ label: t("ends"), value: stamp(r.endsAt) }] : []),
    ...(r.dueAt ? [{ label: t("due"), value: stamp(r.dueAt) }] : []),
    ...(r.timeZone && (r.startsAt || r.endsAt || r.dueAt)
      ? [{ label: t("timeZone"), value: r.timeZone }]
      : []),
    ...(r.blockerText ? [{ label: t("blocker"), value: r.blockerText }] : []),
  ];
  if (loaded === null) return null;
  const { RecordPeek, ShellPeekSections } = loaded;
  return (
    <RecordPeek
      org={org}
      recordKey={r.key}
      kind={r.kind}
      title={r.title}
      state={r.state}
      properties={properties}
    >
      <section aria-labelledby="shell-peek-activity" className="flex flex-col gap-8">
        <h3 id="shell-peek-activity" className="m-0 text-label-13 font-semibold">
          {t("activity")}
        </h3>
        {r.history.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("noActivity")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-6 p-0 text-text-13">
            {r.history.map((h) => (
              <li key={h.id} className="flex flex-col gap-2">
                <span>
                  {h.from
                    ? t("stateChange", { from: stateName(h.from), to: stateName(h.to) })
                    : t("stateSet", { to: stateName(h.to) })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("byWhen", { name: h.byName ?? t("system"), when: stamp(h.at) })}
                  {h.reason ? ` · ${h.reason}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <ShellPeekSections org={org} record={r} onChange={() => setVersion((v) => v + 1)} />
      <NextLink
        href={`/${org}/r/${encodeURIComponent(r.key)}` as Route}
        className="text-text-13 font-medium text-accent-text no-underline hover:underline"
      >
        {t("openFull")}
      </NextLink>
    </RecordPeek>
  );
}
