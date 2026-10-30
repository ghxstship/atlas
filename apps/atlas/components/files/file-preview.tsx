"use client";

import type { Attachment } from "@xos/data/attachments";
import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import { canPreview, filePreviewSrc } from "@/lib/files/preview";

/** The previewer and pdf.js load the first time someone points at Preview, never with the page. */
const panel = onDemand(() => import("./file-preview-panel"));

export interface FilePreviewTarget {
  /** The delivery route the file previews and downloads from, such as /files/{version}. */
  readonly src: string;
  readonly name: string;
  /** The content type as stored; the previewer renders what the route delivers. */
  readonly contentType: string | null;
  readonly sizeBytes?: number | null;
  /** Section 8.6 classification, to say that a classified file previews with the watermark. */
  readonly classification?: string | null;
}

/**
 * Preview for a file row (A142): opens the file in @xos/ui FilePreviewer in a drawer. Rows whose type
 * the previewer neither renders nor explains show nothing.
 */
export function FilePreviewButton(props: FilePreviewTarget) {
  const t = useTranslations("collab.preview");
  const [wanted, setWanted] = useState(false);
  const [open, setOpen] = useState(false);
  const loaded = useOnDemand(panel, wanted || open);
  if (!canPreview(props.contentType)) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        aria-haspopup="dialog"
        loading={open && loaded === null}
        onPointerEnter={() => setWanted(true)}
        onFocus={() => setWanted(true)}
        onClick={() => setOpen(true)}
      >
        {t("open")}
      </Button>
      {open && loaded ? (
        <loaded.FilePreviewPanel {...props} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** Preview for an attachment row: its current clean version, when there is one. */
export function AttachmentPreview({
  attachment,
}: {
  attachment: Pick<Attachment, "title" | "classification" | "current">;
}) {
  const version = attachment.current;
  if (!version) return null;
  return (
    <FilePreviewButton
      src={filePreviewSrc(version.id)}
      name={version.filename || attachment.title}
      contentType={version.contentType}
      sizeBytes={version.sizeBytes}
      classification={attachment.classification}
    />
  );
}
