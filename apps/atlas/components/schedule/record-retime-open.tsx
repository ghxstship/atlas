"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useCopy } from "@/components/work/action-ui";

const RecordRetime = dynamic(() => import("./record-retime").then((m) => m.RecordRetime));

/**
 * The record page's Retime by minutes (P8): a button that renders with the page and answers from its first click, and
 * the form, which loads when the person opens it, so a record page does not carry it (ADR 0027 decision 4).
 */
export function RecordRetimeOpen({ org, recordId }: { org: string; recordId: string }) {
  const t = useCopy("schedule");
  const [open, setOpen] = useState(false);
  if (open) return <RecordRetime org={org} recordId={recordId} />;
  return (
    <div>
      <Button onClick={() => setOpen(true)}>{t("retime.title")}</Button>
    </div>
  );
}
