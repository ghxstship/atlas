"use client";

import type { FormField } from "@xos/data/workforce-forms";
import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { RevealPanel } from "@/components/projects/outside-access/reveal-panel";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { Revealed } from "@/lib/outside-access/actions";

const linkDialog = onDemand(() => import("./form-link-dialog"));

/**
 * Public link on a Published form (B2, ADR 0141). A form with a photo field, signature or GPS stamp stays with members,
 * and the control says so rather than offering what the database would refuse. The one-time link, code and QR stay in
 * this control's state, not in anything a refresh replaces.
 */
export function FormLinkAction({
  org,
  templateId,
  fields,
  requiresSignature,
  requiresLocation,
}: {
  org: string;
  templateId: string;
  fields: readonly FormField[];
  requiresSignature: boolean;
  requiresLocation: boolean;
}) {
  const t = useTranslations("workforce.forms.publicLink");
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const dialog = useOnDemand(linkDialog, open);
  if (requiresSignature || requiresLocation || fields.some((f) => f.kind === "photo")) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("unsupported")}</p>;
  }
  return (
    <div className="flex flex-col gap-8">
      {revealed ? <RevealPanel revealed={revealed} onDismiss={() => setRevealed(null)} /> : null}
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onMouseEnter={() => void linkDialog.load()}
          onFocus={() => void linkDialog.load()}
          onClick={() => setOpen(true)}
        >
          {t("create")}
        </Button>
      </div>
      {open && dialog ? (
        <dialog.FormLinkDialog
          org={org}
          templateId={templateId}
          onCreated={(value) => {
            setRevealed(value);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
