"use client";

import { Button, Drawer, FilePreviewer, InlineAlert, type IconName } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  PREVIEW_MAX_BYTES,
  dispositionFilename,
  nextZoom,
  previewKind,
  type PreviewKind,
} from "@/lib/files/preview";
import type { FilePreviewTarget } from "./file-preview";
import type { PdfPages } from "./pdf-render";

/**
 * The file previewer (A142), loaded on demand by FilePreviewButton. It fetches the file from its
 * delivery route, so the route decides what the viewer receives: a Confidential or Restricted PDF or
 * image arrives as the watermarked PDF, a refusal arrives as the route's own sentence, and the
 * preview draws whatever type was delivered. Office files, other types and files over the size limit
 * are not fetched: the panel offers the download instead.
 */

type Received =
  | { readonly state: "loading" }
  | { readonly state: "skipped"; readonly reason: "office" | "tooLarge" | "unsupported" }
  | { readonly state: "refused"; readonly message: string }
  | { readonly state: "failed" }
  | {
      readonly state: "ready";
      readonly kind: PreviewKind;
      readonly bytes: Uint8Array;
      readonly url: string;
      readonly filename: string;
    };

const ICONS: Record<PreviewKind, IconName> = {
  pdf: "FileText",
  image: "Image",
  video: "File",
  office: "File",
  none: "File",
};

/** Starts the fetch unless the stored type or the size rules the preview out. */
function skipReason(target: FilePreviewTarget): "office" | "tooLarge" | "unsupported" | null {
  const kind = previewKind(target.contentType);
  if (kind === "office") return "office";
  if (kind === "none") return "unsupported";
  if ((target.sizeBytes ?? 0) > PREVIEW_MAX_BYTES) return "tooLarge";
  return null;
}

function useReceived(target: FilePreviewTarget): Received {
  const skip = skipReason(target);
  const [received, setReceived] = useState<Received>(
    skip ? { state: "skipped", reason: skip } : { state: "loading" },
  );
  useEffect(() => {
    if (skip) return undefined;
    const controller = new AbortController();
    let url: string | null = null;
    (async () => {
      const response = await fetch(target.src, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 403) {
        setReceived({ state: "refused", message: await response.text() });
        return;
      }
      if (!response.ok) {
        setReceived({ state: "failed" });
        return;
      }
      const blob = await response.blob();
      url = URL.createObjectURL(blob);
      setReceived({
        state: "ready",
        kind: previewKind(response.headers.get("content-type")),
        bytes: new Uint8Array(await blob.arrayBuffer()),
        url,
        filename: dispositionFilename(response.headers.get("content-disposition"), target.name),
      });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.error("Could not load a file preview", error);
      setReceived({ state: "failed" });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [target.src, target.name, skip]);
  return received;
}

/** The PDF's page count and a canvas showing the current page. */
function usePdf(bytes: Uint8Array | null) {
  const [pdf, setPdf] = useState<PdfPages | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!bytes) return undefined;
    let live = true;
    let opened: PdfPages | null = null;
    import("./pdf-render")
      .then((m) => m.openPdf(bytes))
      .then((p) => {
        opened = p;
        if (live) setPdf(p);
        else p.close();
      })
      .catch((error: unknown) => {
        console.error("Could not open the PDF", error);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      opened?.close();
    };
  }, [bytes]);
  return { pdf, failed };
}

function PdfPage({ pdf, page, zoom }: { pdf: PdfPages; page: number; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const t = useTranslations("collab.preview");
  useEffect(() => {
    if (!canvas.current) return;
    pdf.draw(page, canvas.current, zoom).catch((error: unknown) => {
      console.error("Could not draw the PDF page", error);
    });
  }, [pdf, page, zoom]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={t("pageOf", { page: page + 1, count: pdf.count })}
      data-preview="pdf"
      className="max-w-none border border-border-subtle bg-bg-raised"
    />
  );
}

export function FilePreviewPanel(props: FilePreviewTarget & { readonly onClose: () => void }) {
  const t = useTranslations("collab.preview");
  const format = useFormatter();
  const received = useReceived(props);
  const ready = received.state === "ready" ? received : null;
  const { pdf, failed: pdfFailed } = usePdf(ready?.kind === "pdf" ? ready.bytes : null);
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const classified =
    props.classification === "Confidential" || props.classification === "Restricted";

  const download = () => {
    if (ready) {
      const a = document.createElement("a");
      a.href = ready.url;
      a.download = ready.filename;
      a.click();
    } else {
      window.open(props.src, "_blank", "noopener");
    }
  };

  const kind: PreviewKind = ready?.kind ?? previewKind(props.contentType);
  const zoomable = ready !== null && (kind === "pdf" || kind === "image");
  const pages = kind === "pdf" ? (pdf?.count ?? 0) : 0;
  const meta =
    kind === "pdf" && pdf
      ? t("pages", { count: pdf.count })
      : kind === "image"
        ? t("image")
        : kind === "video"
          ? t("video")
          : "";

  let body;
  if (received.state === "loading" || (kind === "pdf" && ready && !pdf && !pdfFailed)) {
    body = (
      <p role="status" className="m-0 text-text-13 text-text-secondary">
        {t("loading")}
      </p>
    );
  } else if (received.state === "skipped") {
    body = <Fallback message={t(received.reason)} onDownload={download} />;
  } else if (received.state === "refused") {
    body = <InlineAlert tone="danger">{received.message || t("failed")}</InlineAlert>;
  } else if (received.state === "failed" || pdfFailed) {
    body = <InlineAlert tone="danger">{t("failed")}</InlineAlert>;
  } else if (kind === "pdf" && pdf) {
    body = <PdfPage pdf={pdf} page={Math.min(page, pdf.count - 1)} zoom={zoom} />;
  } else if (kind === "image" && ready) {
    body = (
      // A blob URL of the delivered bytes; next/image cannot optimize it.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ready.url}
        alt={props.name}
        data-preview="image"
        style={{ width: `${zoom * 100}%` }}
        className="h-auto max-w-none self-start"
      />
    );
  } else if (kind === "video" && ready) {
    body = (
      <video
        src={ready.url}
        controls
        aria-label={t("videoLabel", { name: props.name })}
        data-preview="video"
        className="max-h-full max-w-full"
      />
    );
  } else {
    // The route delivered a type the previewer does not draw; the header offers the download.
    body = <Fallback message={t("unsupported")} />;
  }

  return (
    <Drawer
      title={props.name}
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      {classified && received.state !== "skipped" ? (
        <InlineAlert tone="info">{t("watermarked")}</InlineAlert>
      ) : null}
      <FilePreviewer
        name={ready?.filename ?? props.name}
        meta={meta}
        icon={ICONS[kind]}
        pages={pages}
        page={page}
        zoom={format.number(zoom, { style: "percent" })}
        zoomable={zoomable}
        onPage={setPage}
        onZoomIn={() => setZoom((z) => nextZoom(z, 1))}
        onZoomOut={() => setZoom((z) => nextZoom(z, -1))}
        // A refusal has nothing to download; a skipped file offers it in the body.
        downloadable={ready !== null}
        onDownload={download}
      >
        {body}
      </FilePreviewer>
    </Drawer>
  );
}

function Fallback({ message, onDownload }: { message: string; onDownload?: () => void }) {
  const t = useTranslations("collab.preview");
  return (
    <div className="flex flex-col items-start gap-12 self-center">
      <p className="m-0 text-text-13 text-text-secondary">{message}</p>
      {onDownload ? (
        <Button type="button" size="sm" onClick={onDownload}>
          {t("download")}
        </Button>
      ) : null}
    </div>
  );
}
