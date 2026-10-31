"use client";

import type { RosterCopyItem, RosterCopySource } from "@xos/data/roster";
import { Button, InlineAlert, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rosterCopyAction } from "@/lib/actions/roster";
import { rosterCopyGroups } from "@/lib/roster-copy";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Reuse a roster from a past event (B14, G-252; ADR 0153 D4), for a roster manager of this engagement who also
 * manages the past one: choose it, preview who is added (Drafts each person still accepts, arrivals moved by the
 * difference of the first show days), which addresses are invited again (one email each) and who is skipped and why,
 * then Add to roster. Nothing is submitted: the manager still submits and the org still reviews.
 */
export function RosterCopyPanel({
  engagementId,
  sources,
  format,
}: {
  engagementId: string;
  sources: readonly RosterCopySource[];
  /** The past engagement's label: its project and first show day, formatted on the server. */
  format: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("gateway.engagement.roster.copy") as unknown as Translate;
  const outcomes = useTranslations("gateway.outcomes") as unknown as Translate;
  const router = useRouter();
  const [source, setSource] = useState(sources[0]?.engagementId ?? "");
  const [items, setItems] = useState<readonly RosterCopyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const run = (commit: boolean) =>
    start(async () => {
      setError(null);
      const result = await rosterCopyAction(engagementId, source, commit);
      if (!result.ok) {
        setError(result.outcome);
        return;
      }
      if (commit) {
        setItems(null);
        setDone(true);
        router.refresh();
      } else {
        setItems(result.items);
        setDone(false);
      }
    });
  const groups = items ? rosterCopyGroups(items) : null;
  const line = (i: RosterCopyItem) =>
    i.skipReason && i.outcome !== "skip" ? `${i.label} (${t(`reasons.${i.skipReason}`)})` : i.label;
  return (
    <section aria-labelledby="roster-copy" className="flex flex-col gap-12">
      <h2 id="roster-copy" className="m-0 text-heading-16 font-semibold">
        {t("title")}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">{t("lead")}</p>
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="roster-copy-source"
          label={t("source")}
          value={source}
          options={sources.map((s) => ({
            value: s.engagementId,
            label: format[s.engagementId] ?? s.projectName,
          }))}
          onChange={(e) => {
            setSource(e.target.value);
            setItems(null);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          loading={pending && !items}
          disabled={!source}
          onClick={() => run(false)}
        >
          {t("preview")}
        </Button>
      </div>
      {error ? <InlineAlert tone="danger">{outcomes(error)}</InlineAlert> : null}
      {done ? (
        <p role="status" className="m-0 text-text-13">
          {t("added")}
        </p>
      ) : null}
      {groups ? (
        <div className="flex flex-col gap-8 text-text-13" aria-live="polite">
          <Group
            title={t("addedPeople", { n: groups.added.length })}
            rows={groups.added.map(line)}
          />
          <Group
            title={t("invitedAddresses", { n: groups.invited.length })}
            rows={groups.invited.map(line)}
          />
          <Group
            title={t("skippedPeople", { n: groups.skipped.length })}
            rows={groups.skipped.map(
              (i) => `${i.label}: ${t(`reasons.${i.skipReason ?? "not_in_team"}`)}`,
            )}
          />
          <div>
            <Button
              type="button"
              variant="primary"
              loading={pending}
              disabled={groups.empty}
              onClick={() => run(true)}
            >
              {t("commit")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Group({ title, rows }: { title: string; rows: readonly string[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <h3 className="m-0 text-text-13 font-semibold">{title}</h3>
      <ul className="m-0 flex list-disc flex-col gap-2 ps-20">
        {rows.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}
