"use client";

import { QRCode } from "@xos/ui";

/** The handoff QR code, split into its own chunk by the lazy import in continue-on-device.tsx. */
export default function HandoffCode({
  url,
  label,
}: {
  readonly url: string;
  readonly label: string;
}) {
  return (
    <div data-handoff-qr="">
      <QRCode value={url} label={label} size={160} />
    </div>
  );
}
