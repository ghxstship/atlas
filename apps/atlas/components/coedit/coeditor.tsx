"use client";

import { Button, PresenceIndicator, RichTextEditor, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { loadHub } from "@/components/live/live-source";
import {
  appendDocUpdateAction,
  compactDocAction,
  openDocAction,
  type CoeditSubject,
} from "@/lib/coedit/actions";
import { CoeditSession, type SessionState } from "./session";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The live co-editor (Section 5, ADR 0044), loaded on demand when someone opens it: Tiptap on a Yjs
 * document whose updates travel over the document's private Realtime channel and are kept in the
 * database. Everyone in the document shows as present; edits merge as they type, and pausing writes
 * the text into the row. Leaving folds what this editor knows into a snapshot.
 */
export function CoEditor({
  org,
  subject,
  id,
  label,
  me,
  onDone,
}: {
  org: string;
  subject: CoeditSubject;
  id: string;
  label: string;
  me: { key: string; name: string };
  onDone: () => void;
}) {
  const t = useTranslations("collab.coedit") as unknown as Translate;
  const [state, setState] = useState<SessionState | null>(null);
  const session = useRef<CoeditSession | null>(null);
  const { key: meKey, name: meName } = me;

  useEffect(() => {
    const live = new CoeditSession({
      me: { key: meKey, name: meName },
      open: (since) => openDocAction(org, subject, id, since),
      append: (docId, generation, update) => appendDocUpdateAction(org, docId, generation, update),
      compact: (docId, generation, snapshot, through, text) =>
        compactDocAction(org, docId, generation, snapshot, through, text),
      room: async (docId, handlers) => {
        const hub = await loadHub();
        return hub
          ? hub.room(`doc:${docId}`, { events: ["update"], presenceKey: meKey }, handlers)
          : null;
      },
      onChange: setState,
    });
    session.current = live;
    void live.start();
    const onHide = () => {
      if (document.visibilityState === "hidden") void live.settle();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void live.settle().finally(() => live.stop());
    };
  }, [org, subject, id, meKey, meName]);

  if (!state || (state.status === "loading" && !state.doc)) {
    return (
      <div className="flex flex-col gap-8" aria-busy="true">
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("loading")}
        </p>
        <Skeleton height={160} />
      </div>
    );
  }
  if (state.status === "error" || !state.doc) {
    return (
      <p role="alert" className="m-0 text-text-13 text-danger-text">
        {t("error")}
      </p>
    );
  }
  const statusText = !state.canEdit
    ? t("readOnly")
    : state.status === "saving"
      ? t("saving")
      : state.status === "offline"
        ? t("offline")
        : t("saved");
  return (
    <div className="flex flex-col gap-8" data-coedit-generation={state.generation}>
      <RichTextEditor
        key={state.generation}
        label={label}
        html=""
        ydoc={state.doc}
        editable={state.canEdit}
        presence={
          state.editors.length > 0 ? (
            <PresenceIndicator names={[...state.editors]} verb="editing" />
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-8">
        <p role="status" className="m-0 text-text-12 text-text-secondary">
          {statusText}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            void session.current?.settle();
            onDone();
          }}
        >
          {t("done")}
        </Button>
      </div>
    </div>
  );
}
