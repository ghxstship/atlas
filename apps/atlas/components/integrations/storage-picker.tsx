"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  browseStorageAction,
  linkStorageFileAction,
  removeFileLinkAction,
  setLinkingFolderAction,
  type BrowseItem,
  type BrowseState,
} from "@/lib/integrations/storage-actions";

/**
 * Browsing a Google Drive or OneDrive connection (B16, ADR 0155 D5). In link mode a document writer moves through the
 * linking folder and links one file to the document; in admin mode an integrations Admin moves through the whole
 * account and chooses the linking folder. Every listing and link is a server action that calls the storage-browse
 * Edge Function as the person. Loaded on demand (components/lazy-ui/storage-picker.tsx), never with the page.
 */

export interface StoragePickerLabels {
  readonly loading: string;
  readonly empty: string;
  readonly up: string;
  readonly choose: string;
  readonly open: string;
  readonly useFolder: string;
}

export function StoragePicker({
  org,
  connectionId,
  documentId,
  mode,
  labels,
}: {
  org: string;
  connectionId: string;
  documentId?: string;
  mode: "link" | "admin";
  labels: StoragePickerLabels;
}) {
  const [listing, setListing] = useState<BrowseState>({});
  const [trail, setTrail] = useState<readonly { id: string | null; name: string }[]>([
    { id: null, name: "" },
  ]);
  const [loading, startLoading] = useTransition();
  const [linked, link, linking] = useActionState(linkStorageFileAction, {});
  const [saved, save, saving] = useActionState(setLinkingFolderAction, {});
  const started = useRef(false);

  const load = (folderId: string | null) => {
    startLoading(async () => {
      const form = new FormData();
      form.set("org", org);
      form.set("connectionId", connectionId);
      if (documentId) form.set("documentId", documentId);
      if (mode === "admin") form.set("mode", "admin");
      form.set("folderId", folderId ?? "");
      setListing(await browseStorageAction({}, form));
    });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load(null);
  });

  const current = trail[trail.length - 1]?.id ?? null;
  const items: readonly BrowseItem[] = listing.items ?? [];
  return (
    <div className="flex flex-col gap-8" data-testid={`storage-picker-${mode}`}>
      <div className="flex flex-wrap items-center gap-8">
        {trail.length > 1 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = trail.slice(0, -1);
              setTrail(next);
              load(next[next.length - 1]?.id ?? null);
            }}
          >
            {labels.up}
          </Button>
        ) : null}
        {mode === "admin" && current !== null ? (
          <form action={save}>
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="connectionId" value={connectionId} />
            <input type="hidden" name="folderId" value={current} />
            <Button type="submit" size="sm" variant="secondary" loading={saving}>
              {labels.useFolder}
            </Button>
          </form>
        ) : null}
      </div>
      {loading ? <p className="m-0 text-text-13 text-text-secondary">{labels.loading}</p> : null}
      {listing.message && !listing.ok ? (
        <InlineAlert tone="danger">{listing.message}</InlineAlert>
      ) : null}
      {!loading && listing.ok && items.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{labels.empty}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {items
          .filter((i) => i.folder || mode === "link")
          .map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center justify-between gap-8 py-6 text-text-13"
            >
              <span className="min-w-0 break-words">{i.name}</span>
              {i.folder ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTrail([...trail, { id: i.id, name: i.name }]);
                    load(i.id);
                  }}
                >
                  {labels.open}
                </Button>
              ) : (
                <form action={link}>
                  <input type="hidden" name="org" value={org} />
                  <input type="hidden" name="connectionId" value={connectionId} />
                  <input type="hidden" name="documentId" value={documentId ?? ""} />
                  <input type="hidden" name="fileId" value={i.id} />
                  <Button type="submit" size="sm" variant="secondary" loading={linking}>
                    {labels.choose}
                  </Button>
                </form>
              )}
            </li>
          ))}
      </ul>
      {linked.message ? (
        <InlineAlert tone={linked.ok ? "success" : "danger"}>{linked.message}</InlineAlert>
      ) : null}
      {saved.message ? (
        <InlineAlert tone={saved.ok ? "success" : "danger"}>{saved.message}</InlineAlert>
      ) : null}
    </div>
  );
}

/** Removes a linked file from a document; the provider's file itself is untouched. */
export function LinkedFileRemove({
  org,
  linkId,
  label,
}: {
  org: string;
  linkId: string;
  label: string;
}) {
  const [state, remove, pending] = useActionState(removeFileLinkAction, {});
  return (
    <form action={remove} className="flex flex-col items-end gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="linkId" value={linkId} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>
        {label}
      </Button>
      {state.message ? (
        <InlineAlert tone={state.ok ? "success" : "danger"}>{state.message}</InlineAlert>
      ) : null}
    </form>
  );
}
