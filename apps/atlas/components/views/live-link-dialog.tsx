"use client";

import type { LiveLink } from "@xos/data/live-links";
import type { ProjectRef } from "@xos/data/work";
import { Button, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState, useTransition } from "react";
import {
  createViewLinkAction,
  loadViewLinksAction,
  type CreatedLiveLinkView,
} from "@/lib/live-links/actions";
import { CreatedLiveLink, dayFromToday, LiveLinkList } from "@/components/live/live-link-list";

/**
 * Share a saved view live (P1, ADR 0130): a no-account link with an access code and an expiry within
 * 90 days, to one project's rows of the view. On a project tab the project is the tab's; on an org
 * page the person picks one. The new link's address and code show once, beside the view's links.
 * Loaded on demand from the view switcher (collection-views.tsx), so collections carry none of it.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function LiveLinkDialog({
  org,
  view,
  projectKey,
  onClose,
}: {
  org: string;
  view: { readonly id: string; readonly name: string };
  /** The project tab's key; null on an org page. */
  projectKey: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("views.liveLink") as unknown as Translate;
  const id = useId();
  const [links, setLinks] = useState<readonly LiveLink[] | null>(null);
  const [projects, setProjects] = useState<readonly ProjectRef[]>([]);
  const [created, setCreated] = useState<CreatedLiveLinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const refresh = useCallback(() => {
    void loadViewLinksAction(org, view.id).then((result) => {
      if (result.ok) {
        setLinks(result.data.links);
        setProjects(result.data.projects);
      } else setError(result.error);
    });
  }, [org, view.id]);
  useEffect(refresh, [refresh]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: view.name })}
      description={t("description")}
      actions={<Button onClick={onClose}>{t("close")}</Button>}
    >
      <div className="flex flex-col gap-16">
        {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        {created ? <CreatedLiveLink id={id} created={created} /> : null}
        <form
          className="flex flex-col gap-8"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError(null);
            start(async () => {
              const result = await createViewLinkAction(org, {
                savedViewId: view.id,
                projectKey: projectKey ?? String(form.get("projectKey") ?? ""),
                expiresOn: String(form.get("expiresOn") ?? ""),
                note: String(form.get("note") ?? ""),
              });
              if (result.ok) {
                setCreated(result.data);
                refresh();
              } else setError(result.error);
            });
          }}
        >
          {projectKey ? null : (
            <Select
              id={`${id}-project`}
              name="projectKey"
              label={t("project")}
              help={t("projectHelp")}
              placeholder={t("project")}
              options={projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))}
            />
          )}
          <Input
            id={`${id}-expires`}
            name="expiresOn"
            type="date"
            label={t("expiresOn")}
            defaultValue={dayFromToday(30)}
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
