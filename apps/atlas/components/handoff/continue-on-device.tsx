"use client";

import { Button, Popover } from "@xos/ui";
import { lazy, Suspense, useState } from "react";

/** The QR code loads only when the person opens the control, so record pages carry no QR encoder. */
const HandoffCode = lazy(() => import("./handoff-code"));

export interface ContinueOnDeviceLabels {
  readonly button: string;
  readonly title: string;
  readonly sentence: string;
  readonly qr: string;
  readonly link: string;
}

/**
 * Continue on another device (Section 11.10 item 13, ADR 0030): a QR code that opens this item in
 * Compass. The server builds the link (`@xos/ia/handoff`) and passes the copy already translated.
 */
export function ContinueOnDevice({
  url,
  labels,
}: {
  readonly url: string;
  readonly labels: ContinueOnDeviceLabels;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      title={labels.title}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm" icon="Smartphone" data-handoff-open="">
          {labels.button}
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-8" data-handoff="">
        <p className="m-0">{labels.sentence}</p>
        {open ? (
          <Suspense fallback={null}>
            <HandoffCode url={url} label={labels.qr} />
          </Suspense>
        ) : null}
        <p className="m-0 w-full text-text-12">
          <span className="sr-only">{labels.link} </span>
          <code className="block break-all font-mono" data-handoff-url="">
            {url}
          </code>
        </p>
      </div>
    </Popover>
  );
}
