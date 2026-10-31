"use client";

import type { LiveLink } from "@xos/data/live-links";
import { Button, Input } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  regenerateLiveLinkAction,
  revokeLiveLinkAction,
  type CreatedLiveLinkView,
} from "@/lib/live-links/actions";

/**
 * The parts both live link dialogs share (P1, ADR 0130): the one-time reveal of a new link's address
 * and access code, and the list of links with their computed state, opens and last open, and
 * Regenerate and Revoke behind a confirmation. Loaded only with a dialog, never with a page.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const t = useTranslations("views.liveLink.created");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-end gap-8">
      <Input id={id} label={label} value={value} readOnly width="100%" />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

/** A new or regenerated link's address and code, shown once. */
export function CreatedLiveLink({ id, created }: { id: string; created: CreatedLiveLinkView }) {
  const t = useTranslations("views.liveLink.created");
  return (
    <div className="flex flex-col gap-8" role="status">
      <h3 className="m-0 text-label-13 font-medium">{t("heading")}</h3>
      <p className="m-0 text-text-12 text-text-secondary">{t("copyOnce")}</p>
      <CopyField id={`${id}-url`} label={t("link")} value={created.url} />
      <CopyField id={`${id}-code`} label={t("code")} value={created.accessCode} />
    </div>
  );
}

function LinkRow({
  org,
  link,
  onChanged,
  onRegenerated,
}: {
  org: string;
  link: LiveLink;
  onChanged: () => void;
  onRegenerated: (created: CreatedLiveLinkView) => void;
}) {
  const t = useTranslations("views.liveLink") as unknown as Translate;
  const format = useFormatter();
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const act = () =>
    start(async () => {
      setError(null);
      if (confirm === "regenerate") {
        const result = await regenerateLiveLinkAction(org, link.id, link.kind);
        if (result.ok) onRegenerated(result.data);
        else setError(result.error);
      } else {
        const result = await revokeLiveLinkAction(org, link.id);
        if (!result.ok) setError(result.error);
      }
      setConfirm(null);
      onChanged();
    });
  const open = link.state === "Active" || link.state === "Locked";
  return (
    <li className="flex flex-col gap-4 py-8">
      <span className="flex flex-wrap items-baseline justify-between gap-8">
        <span className="text-text-13 text-text-primary">
          {link.note ?? t("links.made", { date: date(link.createdAt) })}
        </span>
        <span className="text-text-12 text-text-secondary">{t(`links.states.${link.state}`)}</span>
      </span>
      <span className="text-text-12 text-text-secondary">
        {t("links.expires", { date: date(link.expiresAt) })}
        {" · "}
        {t("links.opened", { count: link.openCount })}
        {link.lastOpenedAt ? ` · ${t("links.lastOpened", { date: date(link.lastOpenedAt) })}` : ""}
        {" · "}
        {t("links.hint", { hint: link.tokenHint })}
      </span>
      {error ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t(`errors.${error}`)}
        </span>
      ) : null}
      {confirm ? (
        <span className="flex flex-col gap-8">
          <span className="text-text-12">
            {t(confirm === "regenerate" ? "links.regenerateConfirm" : "links.revokeConfirm")}
          </span>
          <span className="flex gap-8">
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirm(null)}>
              {t("links.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={confirm === "revoke" ? "danger" : "primary"}
              loading={pending}
              onClick={act}
            >
              {t("links.confirm")}
            </Button>
          </span>
        </span>
      ) : open ? (
        <span className="flex gap-8">
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("regenerate")}>
            {t("links.regenerate")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("revoke")}>
            {t("links.revoke")}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** The links of a saved view or a running order, newest first. */
export function LiveLinkList({
  org,
  links,
  onChanged,
  onRegenerated,
}: {
  org: string;
  links: readonly LiveLink[] | null;
  onChanged: () => void;
  onRegenerated: (created: CreatedLiveLinkView) => void;
}) {
  const t = useTranslations("views.liveLink.links");
  return (
    <div className="flex flex-col gap-4">
      <h3 className="m-0 text-label-13 font-medium">{t("heading")}</h3>
      {links === null ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("loading")}</p>
      ) : links.length === 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {links.map((l) => (
            <LinkRow
              key={l.id}
              org={org}
              link={l}
              onChanged={onChanged}
              onRegenerated={onRegenerated}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A calendar day `offset` days from today, as a date input wants it. */
export function dayFromToday(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
