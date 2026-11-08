"use client";

import { Button } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { MoreActions } from "@/components/shell/more-actions";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { ProjectKeyRef } from "@/lib/outside-access/actions";

/** The panel and its reads load on the first click (ADR 0027); the board is shared, so nothing eager goes with it. */
const panel = onDemand(() => import("./intake-requests-dialog"));
const newLink = onDemand(() => import("./intake-link-dialog"));

/**
 * Intake requests on the project's Engagements tab (B2, ADR 0141): one static, secondary control. New intake link and the
 * way to Outside access sit in its dialog, and a new link's code stays in that link's dialog until closed. With `also`
 * (the tab's other secondary links), Intake requests joins them in one More menu, keeping the header to five actions
 * (gate 27).
 */
export function IntakeRequestsAction({
  refs,
  canCreate,
  also = [],
}: {
  refs: ProjectKeyRef;
  canCreate: boolean;
  also?: readonly { readonly label: string; readonly href: string }[];
}) {
  const t = useTranslations("projects.outsideAccess.requests");
  const router = useRouter();
  const [open, setOpen] = useState<"requests" | "link" | null>(null);
  const requests = useOnDemand(panel, open === "requests");
  const link = useOnDemand(newLink, open === "link");
  return (
    <>
      {also.length > 0 ? (
        <MoreActions
          label={t("more")}
          items={[...also, { label: t("action"), onSelect: () => setOpen("requests") }]}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onMouseEnter={() => void panel.load()}
          onFocus={() => void panel.load()}
          onClick={() => setOpen("requests")}
        >
          {t("action")}
        </Button>
      )}
      {open === "requests" && requests ? (
        <requests.IntakeRequestsDialog
          refs={refs}
          onClose={() => setOpen(null)}
          {...(canCreate
            ? {
                onNewLink: () => {
                  void newLink.load();
                  setOpen("link");
                },
              }
            : {})}
        />
      ) : null}
      {open === "link" && link ? (
        <link.IntakeLinkDialog
          refs={refs}
          onClose={() => {
            setOpen(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
