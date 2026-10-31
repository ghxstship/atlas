"use client";

import { DISPLAY_MODES, type LiveLink } from "@xos/data/live-links";
import { Button, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import {
  createDisplayLinkAction,
  loadDisplayLinksAction,
  type CreatedLiveLinkView,
} from "@/lib/live-links/actions";
import { CreatedLiveLink, dayFromToday, LiveLinkList } from "@/components/live/live-link-list";

/**
 * Display screens for a running order (P1, ADR 0130): a room clock, presenter timer or backstage
 * screen on a no-account link with an access code. The expiry defaults to the end of the day after
 * the show, in the project's zone, which the database works out when the date is left empty. The
 * new link's address and code show once, beside the running order's links. Loaded on demand from the
 * run-of-show peek (display-screens-action.tsx).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function DisplayLinkDialog({
  org,
  run,
  onClose,
}: {
  org: string;
  run: { readonly id: string; readonly name: string };
  onClose: () => void;
}) {
  const t = useTranslations("show.display") as unknown as Translate;
  const errors = useTranslations("views.liveLink.errors") as unknown as Translate;
  const id = useId();
  const [links, setLinks] = useState<readonly LiveLink[] | null>(null);
  const [created, setCreated] = useState<CreatedLiveLinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const refresh = useCallback(() => {
    void loadDisplayLinksAction(org, run.id).then((result) => {
      if (result.ok) setLinks(result.data);
      else setError(result.error);
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
              const result = await createDisplayLinkAction(org, {
                runOfShowId: run.id,
                expiresOn: String(form.get("expiresOn") ?? ""),
                defaultMode: String(form.get("defaultMode") ?? "Backstage"),
                note: String(form.get("note") ?? ""),
              });
              if (result.ok) {
                setCreated(result.data);
                refresh();
              } else setError(result.error);
            });
          }}
        >
          <Select
            id={`${id}-mode`}
            name="defaultMode"
            label={t("defaultMode")}
            help={t("modeKeys")}
            value="Backstage"
            options={DISPLAY_MODES.map((m) => ({ value: m, label: t(`modes.${m}`) }))}
          />
          <Input
            id={`${id}-expires`}
            name="expiresOn"
            type="date"
            label={t("expiresOn")}
            min={dayFromToday(1)}
            max={dayFromToday(90)}
            help={t("expiresHelp")}
          />
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
        <LiveLinkList org={org} links={links} onChanged={refresh} onRegenerated={setCreated} />
      </div>
    </Dialog>
  );
}
