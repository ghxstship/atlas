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
