/**
 * PDF pages drawn with pdf.js (A142), loaded only when a preview opens a PDF. pdf.js runs on the main
 * thread: importing its worker module registers it in place of a Worker, so no worker script URL is
 * served and the CSP needs no worker origin. Nothing in a PDF runs as script; its fonts load from
 * its own bytes. Browser only.
 */
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

/** A PDF opened for drawing; `close` releases it. */
export interface PdfPages {
  readonly count: number;
  /** Draws page `index` (zero-based) on the canvas at `zoom` times its own size. */
  draw(index: number, canvas: HTMLCanvasElement, zoom: number): Promise<void>;
  close(): void;
}

/** One PDF point is one CSS pixel at 100%, as browsers' own viewers draw a page. */
const CSS_PER_POINT = 96 / 72;

export async function openPdf(bytes: Uint8Array): Promise<PdfPages> {
  const [pdfjs] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs"),
  ]);
  const loading = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is given; a copy keeps the caller's bytes usable.
    data: bytes.slice(),
    enableXfa: false,
    useSystemFonts: true,
  });
  const doc: PDFDocumentProxy = await loading.promise;
  let task: RenderTask | null = null;
  return {
    count: doc.numPages,
    async draw(index, canvas, zoom) {
      task?.cancel();
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: zoom * CSS_PER_POINT });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      try {
        await task.promise;
      } catch (error) {
        // A newer draw cancelled this one.
        if ((error as { name?: unknown } | null)?.name !== "RenderingCancelledException")
          throw error;
      }
    },
    close() {
      task?.cancel();
      // Destroying the loading task destroys the document and its worker.
      void loading.destroy();
    },
  };
}

/** The longest side, in pixels, of a site plan page rendered as its drawing (B1, ADR 0140 D3). */
export const PAGE_RASTER_MAX_PX = 4096;

/**
 * One PDF page as a PNG whose long side is at most `maxPx` (B1): a site plan drawn from a PDF shows and exports the
 * page the uploader chose, rendered here from the local file, so the server never renders a PDF. Browser only.
 */
export async function renderPageToPng(
  bytes: Uint8Array,
  pageNumber: number,
  maxPx: number = PAGE_RASTER_MAX_PX,
): Promise<{
  readonly png: Blob;
  readonly width: number;
  readonly height: number;
  readonly pages: number;
}> {
  const [pdfjs] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs"),
  ]);
  const loading = pdfjs.getDocument({
    data: bytes.slice(),
    enableXfa: false,
    useSystemFonts: true,
  });
  try {
    const doc: PDFDocumentProxy = await loading.promise;
    const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
    const natural = page.getViewport({ scale: 1 });
    const scale = maxPx / Math.max(natural.width, natural.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("The page did not render."))),
        "image/png",
      ),
    );
    return { png, width: canvas.width, height: canvas.height, pages: doc.numPages };
  } finally {
    void loading.destroy();
  }
}
