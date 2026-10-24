"use client";

import { Toast, ToastRegion, UndoToast } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { undoStack, type UndoEntry } from "./undo-stack";

type Translate = (key: string, values?: Record<string, string>) => string;

/** How long an outcome notice stays: long enough to read, short of the next action. */
const NOTICE_MS = 6_000;

/**
 * The shell's view of the undo stack (Section 11.7): the latest action's Undo toast for 8 seconds,
 * then what an undo or redo did, in one polite region. Cmd or Ctrl+Z works whether or not the
 * toast is still showing; the toast is only the visible way in.
 */
export function UndoCenter() {
  const t = useTranslations("collab.undo") as unknown as Translate;
  const [latest, setLatest] = useState<UndoEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () =>
      undoStack.subscribe((event) => {
        if (event.kind === "pushed") {
          setNotice(null);
          setLatest(event.entry.toast === false ? null : event.entry);
          return;
        }
        if (event.kind === "empty") {
          setNotice(t(event.direction === "undo" ? "nothingToUndo" : "nothingToRedo"));
          return;
        }
        setLatest((current) => (current?.id === event.entry.id ? null : current));
        if (event.kind === "failed") {
          setNotice(event.message ? t("failed", { message: event.message }) : t("failedPlain"));
        } else {
          setNotice(t(event.kind, { label: event.entry.label }));
        }
      }),
    [t],
  );

  useEffect(() => {
    if (notice === null) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <ToastRegion label={t("notifications")}>
      {latest ? (
        <UndoToast
          key={latest.id}
          message={latest.label}
          onUndo={() => void undoStack.undo(latest.id)}
          onExpire={() => setLatest(null)}
        />
      ) : null}
      {notice ? (
        <Toast message={notice} actionLabel={t("dismiss")} onAction={() => setNotice(null)} />
      ) : null}
    </ToastRegion>
  );
}
