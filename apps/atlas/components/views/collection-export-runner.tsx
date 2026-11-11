"use client";

import { Toast, ToastRegion } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useStepUp } from "@/components/auth/security/step-up";
import {
  collectionExportDownloadAction,
  collectionExportStatusAction,
  requestCollectionExportAction,
  type ExportError,
} from "@/lib/views/export-actions";
import type { Database } from "@xos/data/database.types";

/** Copy lookups take built keys (`export.errors.denied`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

export type Format = Database["app"]["Enums"]["export_format"];

/** How often the menu asks after a queued export, and after how many asks it says it is slow. */
const POLL_MS = 2_000;
const SLOW_AFTER = 45;

type Notice =
  | { readonly kind: "progress"; readonly message: string }
  | { readonly kind: "ready"; readonly message: string; readonly id: string }
  | { readonly kind: "error"; readonly message: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One export the menu asked for; `at` tells two asks for the same format apart. */
export interface ExportAsk {
  readonly format: Format;
  readonly at: number;
}

/**
 * The export itself, loaded the first time someone picks a format (A24-009): it asks for the export, asks
 * for step-up when Restricted columns need it, follows the export.render worker in a toast and downloads
 * the file when it is ready. CollectionExport keeps only the menu in every collection's JavaScript.
 */
export function ExportRunner({
  org,
  pathname,
  ask,
  onBusy,
}: {
  readonly org: string;
  readonly pathname: string;
  readonly ask: ExportAsk;
  readonly onBusy: (busy: boolean) => void;
}) {
  const t = useTranslations("views") as unknown as Translate;
  const search = useSearchParams();
  const { request: askStepUp, dialog } = useStepUp();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  // Follows a queued export until the worker has written its file, then downloads it.
  useEffect(() => {
    if (following === null) return undefined;
    let cancelled = false;
    const run = async () => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        const state = await collectionExportStatusAction(org, following);
        if (cancelled) return;
        if (!state.ok) {
          setFollowing(null);
          setNotice({ kind: "error", message: t(`export.errors.${state.error}`) });
          return;
        }
        if (state.data.status === "Ready") {
          setFollowing(null);
          setNotice({
            kind: "ready",
            id: following,
            message: t("export.status.ready", { rows: state.data.rowCount ?? 0 }),
          });
          setDownloading(following);
          return;
        }
        if (state.data.status === "Failed" || state.data.status === "Expired") {
          setFollowing(null);
          const error: ExportError = state.data.status === "Expired" ? "expired" : "unexpected";
          setNotice({ kind: "error", message: t(`export.errors.${error}`) });
          return;
        }
        if (attempt === SLOW_AFTER)
          setNotice({ kind: "progress", message: t("export.status.slow") });
        await wait(POLL_MS);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [following, org, t]);

  // Downloads a ready export through a signed link; a Restricted one may ask for step-up again.
  useEffect(() => {
    if (downloading === null) return undefined;
    let cancelled = false;
    const id = downloading;
    void collectionExportDownloadAction(org, id).then((link) => {
      if (cancelled) return;
      setDownloading(null);
      if (link.ok) window.location.assign(link.data.url);
      else if (link.error === "stepUp") askStepUp(() => setDownloading(id));
      else setNotice({ kind: "error", message: t(`export.errors.${link.error}`) });
    });
    return () => {
      cancelled = true;
    };
  }, [downloading, org, t, askStepUp]);

  function request(format: Format) {
    setRequesting(true);
    setNotice({ kind: "progress", message: t("export.status.preparing") });
    void requestCollectionExportAction(org, { pathname, search: search.toString(), format }).then(
      (result) => {
        setRequesting(false);
        if (result.ok) {
          setFollowing(result.data.id);
          return;
        }
        if (result.error === "stepUp") {
          // The Restricted columns need a second factor; verifying asks for the export again.
          setNotice(null);
          askStepUp(() => request(format));
          return;
        }
        setNotice({ kind: "error", message: t(`export.errors.${result.error}`) });
      },
    );
  }

  const busy = requesting || following !== null;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  // Each new ask from the menu starts an export.
  useEffect(() => {
    request(ask.format);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one export per ask
  }, [ask]);

  return (
    <>
      <ToastRegion label={t("export.notifications")}>
        {notice ? (
          <Toast
            message={notice.message}
            {...(notice.kind === "ready"
              ? { actionLabel: t("export.download"), onAction: () => setDownloading(notice.id) }
              : notice.kind === "error"
                ? { actionLabel: t("export.dismiss"), onAction: () => setNotice(null) }
                : {})}
          />
        ) : null}
      </ToastRegion>
      {dialog}
    </>
  );
}
