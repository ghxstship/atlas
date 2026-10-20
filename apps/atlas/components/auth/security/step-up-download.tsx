"use client";

import { InlineAlert } from "@xos/ui";
import { useState, useTransition, type MouseEvent } from "react";
import { stepUpStatusAction } from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";
import { useStepUp } from "./step-up";

/**
 * A download link for data that needs step-up (Section 9: "step-up authentication is required for data export"):
 * it checks the session first and, when the session has not passed a second factor, opens the step-up dialog
 * and downloads once the person verifies. The route behind it refuses without step-up on its own.
 */
export function StepUpDownloadLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: string;
}) {
  const t = useSecurityCopy();
  const stepUp = useStepUp();
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const download = () => {
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  };
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    start(async () => {
      setError(null);
      const status = await stepUpStatusAction();
      if (!status.ok) return setError(status.error);
      if (status.data.steppedUp) download();
      else stepUp.request(download);
    });
  };
  return (
    <>
      {/* No download attribute: before the page is live a click opens the route, which serves the file with
          step-up and otherwise returns to this page, rather than saving that redirect as a file. */}
      <a href={href} onClick={onClick} className={className}>
        {children}
      </a>
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      {stepUp.dialog}
    </>
  );
}
