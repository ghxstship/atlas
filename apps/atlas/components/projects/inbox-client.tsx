"use client";

import { Button, Input } from "@xos/ui";
import { useState } from "react";

/** A read-only value with a copy button, for the project inbox address. */
export function CopyValue({
  id,
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  id: string;
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-12">
      <Input id={id} readOnly label={label} value={value} />
      <Button
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        }}
      >
        {copyLabel}
      </Button>
      {copied ? (
        <span role="status" className="text-text-13 text-success-text">
          {copiedLabel}
        </span>
      ) : null}
    </div>
  );
}
