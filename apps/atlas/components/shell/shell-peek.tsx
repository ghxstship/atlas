"use client";

import { Button, InlineAlert } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { RecordPeek } from "@/components/work/record-peek";
import { withQuery } from "@/components/work/format";
import { loadShellPeekAction, type ShellPeekResult } from "@/lib/shell/peek-actions";
import { pageOwnsPeek } from "@/lib/shell/peek";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** How long a collection page has to open its own peek before the shell opens the record. */
const CLAIM_WAIT_MS = 600;

/**
 * The shell's global `?peek={recordKey}` hook: on every Atlas route that does not peek its own rows,
 * the record the key names opens in the side peek, and on a collection page it opens when the page
 * shows no panel of its own for the key; closing it removes the parameter. Aurora citation
 * links and proposed sitemap nodes rely on it (see lib/shell/peek.ts).
 */
export function ShellPeek({ org }: { org: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const t = useTranslations("peek") as unknown as Translate;
  const key = search.get("peek");
  const owned = pageOwnsPeek(pathname);
  // On a collection page the page's own peek opens first. When the page shows no panel for the key
  // (a collection that does not peek, or a key from elsewhere), the shell opens the record instead.
  const [unclaimed, setUnclaimed] = useState<string | null>(null);
  const active = key !== null && key.length > 0 && (!owned || unclaimed === `${pathname}?${key}`);
  const [result, setResult] = useState<{ key: string; value: ShellPeekResult } | null>(null);

  useEffect(() => {
    if (!owned || key === null || key.length === 0) return;
    const marker = `${pathname}?${key}`;
    const timer = window.setTimeout(() => {
      if (document.querySelector('[role="dialog"]') === null) setUnclaimed(marker);
    }, CLAIM_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [owned, key, pathname]);

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
  }, [active, key, org]);

  if (!active || key === null) return null;
  const close = () =>
    router.replace(withQuery(pathname, search, { peek: null }) as Route, { scroll: false });
  const current = result?.key === key ? result.value : null;
  if (current === null) {
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
  const properties = [
    { label: t("project"), value: `${r.projectKey} · ${r.projectName}` },
    { label: t("owner"), value: r.ownerName ?? t("unassigned") },
    ...(r.dueAt
      ? [
          {
            label: t("due"),
            value: new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
              ...(r.timeZone ? { timeZone: r.timeZone } : {}),
            }).format(new Date(r.dueAt)),
          },
        ]
      : []),
  ];
  return (
    <RecordPeek
      org={org}
      recordKey={r.key}
      kind={r.kind}
      title={r.title}
      state={r.state}
      properties={properties}
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("openFullHint")}</p>
    </RecordPeek>
  );
}
