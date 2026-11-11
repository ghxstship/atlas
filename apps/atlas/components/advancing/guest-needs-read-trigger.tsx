"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

// Reading is logged, so the reader loads and reads only when asked.
const GuestNeedsReader = dynamic(() =>
  import("./guest-needs-reader").then((m) => m.GuestNeedsReader),
);

type Translate = (key: string) => string;

/** For holders of data.restricted.read.medical on the project only: the page renders it for nobody else. */
export function GuestNeedsReadTrigger({ org, projectId }: { org: string; projectId: string }) {
  const t = useTranslations("workDetails.consent.guestNeeds") as unknown as Translate;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {t("read")}
      </Button>
      {open ? (
        <GuestNeedsReader org={org} projectId={projectId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
