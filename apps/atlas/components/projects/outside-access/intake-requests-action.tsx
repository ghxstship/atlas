"use client";

import { Button } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { ProjectKeyRef } from "@/lib/outside-access/actions";

/** The panel and its reads load on the first click (ADR 0027); the board is shared, so nothing eager goes with it. */
const panel = onDemand(() => import("./intake-requests-dialog"));
const newLink = onDemand(() => import("./intake-link-dialog"));

/**
 * Intake requests and New intake link on the project's Engagements tab (B2, ADR 0141): static, secondary controls, with
 * the way to Outside access beside them. A new link's code stays in its dialog until closed, not in this toolbar row.
 */
export function IntakeRequestsAction({
  refs,
  canCreate,
}: {
  refs: ProjectKeyRef;
  canCreate: boolean;
}) {
  const t = useTranslations("projects.outsideAccess.requests");
  const access = useTranslations("projects.outsideAccess");
  const router = useRouter();
  const [open, setOpen] = useState<"requests" | "link" | null>(null);
  const requests = useOnDemand(panel, open === "requests");
  const link = useOnDemand(newLink, open === "link");
  return (
    <>
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
      {canCreate ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onMouseEnter={() => void newLink.load()}
          onFocus={() => void newLink.load()}
          onClick={() => setOpen("link")}
        >
          {access("newIntake")}
        </Button>
      ) : null}
      <NextLink
        className="text-label-13 text-accent-text underline"
        href={`/${refs.org}/p/${refs.projectKey}/settings#outside-access` as Route}
      >
        {access("title")}
      </NextLink>
      {open === "requests" && requests ? (
        <requests.IntakeRequestsDialog refs={refs} onClose={() => setOpen(null)} />
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
