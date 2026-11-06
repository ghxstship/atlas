"use client";

import { InlineAlert } from "@xos/ui";
import { createContext, useContext, useState, type ReactNode } from "react";

const ReportResult = createContext<((message: string) => void) | null>(null);

/**
 * Where the result of an act shows when the control that did it leaves after the refresh: an Override on a row that
 * stops being overridable, a removed requirement, a guest who moves on. The region stands above the section that
 * changes and stays mounted through the refresh, so the sentence is still there to read.
 */
export function ResultRegion({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <ReportResult.Provider value={setMessage}>
      <div role="status">
        {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
      </div>
      {children}
    </ReportResult.Provider>
  );
}

/** Reports a result to the region above; outside one it does nothing. */
export function useReportResult(): (message: string) => void {
  const report = useContext(ReportResult);
  return report ?? (() => undefined);
}
