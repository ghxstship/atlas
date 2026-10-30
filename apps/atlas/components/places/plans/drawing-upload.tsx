"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  planFileStatusAction,
  uploadPlanFileAction,
  setDrawingAction,
} from "@/app/[org]/places/plan-actions";
import { INITIAL_STATE } from "../kit/action-state";
import { useCopy } from "../kit/form";

type Uploaded = {
  readonly drawing: string;
  readonly raster: string | null;
  readonly page: number | null;
};

/**
 * Upload a site plan's drawing (ADR 0140 D3), loaded on demand on a Draft plan. A PNG or JPEG is the drawing; from a
 * PDF, the chosen page is rendered here from the local file to a PNG of at most 4096 px on the long side (pdf.js, A142)
 * and both files are uploaded as attachments on the plan. Once the virus scan marks them Clean, "Use as drawing" sets
 * them; the server measures the image and the database checks the files.
 */
export function DrawingUpload({
  org,
  sitePlanId,
  hasPins,
}: {
  org: string;
  sitePlanId: string;
  hasPins: boolean;
}) {
  const t = useCopy("places");
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [clean, setClean] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!uploaded || clean) return;
    const ids = [uploaded.drawing, ...(uploaded.raster ? [uploaded.raster] : [])];
    const timer = window.setInterval(() => {
      void planFileStatusAction(org, ids).then((status) => {
        const states = ids.map((id) => status[id]);
        if (states.every((s) => s === "Clean")) setClean(true);
        else if (states.some((s) => s === "Infected" || s === "Scan Failed")) {
          setError("fileInfected");
          setUploaded(null);
        }
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [org, uploaded, clean]);

  const choose = async (next: File | null) => {
    setFile(next);
    setUploaded(null);
    setClean(false);
    setError(null);
    setPages(null);
    setPage(1);
    if (next?.type === "application/pdf") {
      const { openPdf } = await import("@/components/files/pdf-render");
      const doc = await openPdf(new Uint8Array(await next.arrayBuffer()));
      setPages(doc.count);
      doc.close();
    }
  };

  const send = (body: Blob, name: string) => {
    const form = new FormData();
    form.set("org", org);
    form.set("sitePlanId", sitePlanId);
    form.set("file", new File([body], name, { type: body.type }));
    return uploadPlanFileAction(form);
  };

  const upload = () =>
    start(async () => {
      if (!file) return;
      setError(null);
      const drawing = await send(file, file.name);
      if (!drawing.ok) return setError(drawing.error);
      let raster: string | null = null;
      if (file.type === "application/pdf") {
        const { renderPageToPng } = await import("@/components/files/pdf-render");
        const rendered = await renderPageToPng(new Uint8Array(await file.arrayBuffer()), page);
        const png = await send(
          rendered.png,
          `${file.name.replace(/\.pdf$/i, "")}-page-${page}.png`,
        );
        if (!png.ok) return setError(png.error);
        raster = png.versionId;
      }
      setUploaded({ drawing: drawing.versionId, raster, page: raster ? page : null });
    });

  const use = () =>
    start(async () => {
      if (!uploaded) return;
      const form = new FormData();
      form.set("org", org);
      form.set("sitePlanId", sitePlanId);
      form.set("drawingVersionId", uploaded.drawing);
      if (uploaded.raster) form.set("rasterVersionId", uploaded.raster);
      if (uploaded.page) form.set("page", String(uploaded.page));
      const result = await setDrawingAction(INITIAL_STATE, form);
      if (result.ok) router.refresh();
      else setError(result.error ?? "unexpected");
    });

  return (
    <section aria-labelledby="drawing-upload-heading" className="flex flex-col gap-12">
      <h3 id="drawing-upload-heading" className="m-0 text-text-14 font-semibold">
        {t("plans.drawing.upload")}
      </h3>
      {hasPins ? <InlineAlert tone="warning">{t("plans.drawing.oldFrame")}</InlineAlert> : null}
      <label className="flex flex-col gap-4 text-text-13">
        <span>{t("plans.drawing.file")}</span>
        <input
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          onChange={(e) => void choose(e.currentTarget.files?.[0] ?? null)}
          className="text-text-13"
        />
        <span className="text-text-12 text-text-secondary">{t("plans.drawing.help")}</span>
      </label>
      {pages !== null ? (
        <Input
          id="drawing-page"
          type="number"
          min="1"
          max={String(pages)}
          label={t("plans.drawing.page", { count: pages })}
          value={String(page)}
          onChange={(e) =>
            setPage(Math.min(pages, Math.max(1, Number(e.currentTarget.value) || 1)))
          }
        />
      ) : null}
      {error ? (
        <InlineAlert tone="danger" title={t("errors.title")}>
          {t(`errors.${error}`)}
        </InlineAlert>
      ) : null}
      {uploaded && !clean ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("plans.drawing.checking")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-8">
        {!uploaded ? (
          <Button variant="secondary" disabled={!file || pending} onClick={upload}>
            {t("plans.drawing.uploadAction")}
          </Button>
        ) : (
          <Button variant="primary" disabled={!clean || pending} onClick={use}>
            {t("plans.drawing.use")}
          </Button>
        )}
      </div>
    </section>
  );
}
