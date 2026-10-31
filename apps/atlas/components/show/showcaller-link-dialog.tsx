"use client";

import { MAX_SHOWCALLER_LINK_DAYS, type ShowcallerLink } from "@xos/data/showcaller-links";
import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import { CreatedLiveLink, dayFromToday } from "@/components/live/live-link-list";
import { expiresBeforeShow } from "@/lib/showcaller/expiry";
import {
  createShowcallerLinkAction,
  loadShowcallerLinksAction,
  regenerateShowcallerLinkAction,
  revokeShowcallerLinkAction,
  signOutShowcallerDevicesAction,
  type CreatedShowcallerLinkView,
} from "./depth-actions";

/**
 * Showcaller links for a running order (B3, G-80, ADR 0142): a no-account link and access code that let an outside
 * showcaller call this running order and edit it live until it expires. The expiry defaults to the end of the day
 * after the show, at most 14 days ahead, which the database works out when the date is left empty; the dialog warns
 * when a chosen day ends before the show. The new link's address and code show once. Loaded on demand from the
 * run-of-show peek (showcaller-links-action.tsx).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

function LinkRow({
  org,
  link,
  onChanged,
  onRegenerated,
}: {
  org: string;
  link: ShowcallerLink;
  onChanged: () => void;
  onRegenerated: (created: CreatedShowcallerLinkView) => void;
}) {
  const t = useTranslations("show.showcallerLinks") as unknown as Translate;
  const errors = useTranslations("work.errors") as unknown as Translate;
  const format = useFormatter();
  const [confirm, setConfirm] = useState<"regenerate" | "signOut" | "revoke" | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const act = () =>
    start(async () => {
      setError(null);
      const result =
        confirm === "regenerate"
          ? await regenerateShowcallerLinkAction(org, link.id)
          : confirm === "signOut"
            ? await signOutShowcallerDevicesAction(org, link.id)
            : await revokeShowcallerLinkAction(org, link.id);
      if (!result.ok) setError(result.error.key);
      else if (confirm === "regenerate" && result.data && typeof result.data === "object") {
        onRegenerated(result.data as CreatedShowcallerLinkView);
      }
      setConfirm(null);
      onChanged();
    });
  const open = link.state === "Active" || link.state === "Locked";
  return (
    <li className="flex flex-col gap-4 py-8">
      <span className="flex flex-wrap items-baseline justify-between gap-8">
        <span className="text-text-13 text-text-primary">{link.callerName}</span>
        <span className="text-text-12 text-text-secondary">{t(`states.${link.state}`)}</span>
      </span>
      <span className="text-text-12 text-text-secondary">
        {t("expires", { date: date(link.expiresAt) })}
        {" · "}
        {t("devices", { count: link.devices ?? 0 })}
        {" · "}
        {link.lastOpenedAt ? t("lastOpened", { date: date(link.lastOpenedAt) }) : t("neverOpened")}
        {" · "}
        {t("hint", { hint: link.tokenHint })}
      </span>
      {link.note ? <span className="text-text-12 text-text-secondary">{link.note}</span> : null}
      {error ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {errors(error)}
        </span>
      ) : null}
      {confirm ? (
        <span className="flex flex-col gap-8">
          <span className="text-text-12">{t(`${confirm}Confirm`)}</span>
          <span className="flex gap-8">
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={confirm === "revoke" ? "danger" : "primary"}
              loading={pending}
              onClick={act}
            >
              {t("confirm")}
            </Button>
          </span>
        </span>
      ) : open ? (
        <span className="flex flex-wrap gap-8">
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("regenerate")}>
            {t("regenerate")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("signOut")}>
            {t("signOut")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("revoke")}>
            {t("revoke")}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

export function ShowcallerLinkDialog({
  org,
  run,
  onClose,
}: {
  org: string;
  run: { readonly id: string; readonly name: string; readonly showDate: string };
  onClose: () => void;
}) {
  const t = useTranslations("show.showcallerLinks") as unknown as Translate;
  const errors = useTranslations("work.errors") as unknown as Translate;
  const id = useId();
  const [links, setLinks] = useState<readonly ShowcallerLink[] | null>(null);
  const [created, setCreated] = useState<CreatedShowcallerLinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiresOn, setExpiresOn] = useState("");
  const [pending, start] = useTransition();

  const refresh = useCallback(() => {
    void loadShowcallerLinksAction(org, run.id).then((result) => {
      if (result.ok) setLinks(result.data);
      else setError(result.error.key);
    });
  }, [org, run.id]);
  useEffect(refresh, [refresh]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: run.name })}
      description={t("description")}
      actions={<Button onClick={onClose}>{t("close")}</Button>}
    >
      <div className="flex flex-col gap-16">
        <InlineAlert tone="warning">{t("warning")}</InlineAlert>
        {error ? <InlineAlert tone="danger">{errors(error)}</InlineAlert> : null}
        {created ? <CreatedLiveLink id={id} created={created} /> : null}
        <form
          className="flex flex-col gap-8"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError(null);
            start(async () => {
              const result = await createShowcallerLinkAction(org, {
                runId: run.id,
                callerName: String(form.get("callerName") ?? ""),
                expiresOn,
                note: String(form.get("note") ?? ""),
              });
              if (result.ok) {
                setCreated(result.data);
                refresh();
              } else setError(result.error.key);
            });
          }}
        >
          <Input
            id={`${id}-caller`}
            name="callerName"
            label={t("callerName")}
            help={t("callerNameHelp")}
            maxLength={120}
            required
          />
          <Input
            id={`${id}-expires`}
            name="expiresOn"
            type="date"
            label={t("expiresOn")}
            min={dayFromToday(1)}
            max={dayFromToday(MAX_SHOWCALLER_LINK_DAYS)}
            help={t("expiresHelp")}
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
          {expiresBeforeShow(expiresOn, run.showDate) ? (
            <InlineAlert tone="warning">{t("expiresBeforeShow")}</InlineAlert>
          ) : null}
          <Input
            id={`${id}-note`}
            name="note"
            label={t("note")}
            help={t("noteHelp")}
            maxLength={200}
          />
          <div>
            <Button type="submit" size="sm" loading={pending}>
              {t("submit")}
            </Button>
          </div>
        </form>
        <div className="flex flex-col gap-4">
          <h3 className="m-0 text-label-13 font-medium">{t("listHeading")}</h3>
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
                  onChanged={refresh}
                  onRegenerated={setCreated}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
