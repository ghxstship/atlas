"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { type CodeSampleProps } from "./Marketing.types.ts";

/** How long the copy button shows its confirmation, in milliseconds. */
const COPIED_FOR = 2000;

/**
 * A labeled block of code with a copy button. The copy is announced, and when the clipboard is
 * unavailable the text stays selectable in a focusable, scrollable region.
 */
export function CodeSample({ label, code }: CodeSampleProps): ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    const confirm = () => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_FOR);
    };
    // A frame without clipboard access, or a refused write, leaves the text selectable.
    void navigator.clipboard?.writeText(code).then(confirm, () => undefined);
  };

  return (
    <div className="xos-mkt-code">
      <div className="xos-mkt-code-bar">
        <span className="xos-mkt-label">{label}</span>
        <Button size="sm" variant="ghost" icon={copied ? "Check" : "Copy"} onClick={copy}>
          {t("mk.code.copy")}
        </Button>
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? t("mk.code.copied") : ""}
        </span>
      </div>
      <pre tabIndex={0} role="region" aria-label={label}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
