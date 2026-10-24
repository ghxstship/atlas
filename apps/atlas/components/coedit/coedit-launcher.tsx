"use client";

import { Button } from "@xos/ui";
import { useState, type ReactNode } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { CoeditSubject } from "@/lib/coedit/actions";

/**
 * Yjs, Tiptap and the Realtime room load only when someone opens the live editor (ADR 0027), so a
 * page that shows the text never ships them.
 */
const editorModule = onDemand(() => import("./coeditor"));

/**
 * The text of a co-edited field, and the button that opens it for live editing (Section 5). The
 * editor loads on the first press, or as the pointer approaches the button.
 */
export function CoEditLauncher({
  org,
  subject,
  id,
  label,
  me,
  openLabel,
  loadingLabel,
  children,
}: {
  org: string;
  subject: CoeditSubject;
  id: string;
  /** The field's name, the editor's accessible name. */
  label: string;
  me: { key: string; name: string };
  openLabel: string;
  loadingLabel: string;
  /** The field as people read it while nobody here is editing. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const loaded = useOnDemand(editorModule, open);
  if (open) {
    return loaded ? (
      <loaded.CoEditor
        org={org}
        subject={subject}
        id={id}
        label={label}
        me={me}
        onDone={() => setOpen(false)}
      />
    ) : (
      <p role="status" className="m-0 text-text-13 text-text-secondary">
        {loadingLabel}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      {children}
      <div>
        <Button
          icon="Users"
          onPointerEnter={() => void editorModule.load().catch(() => undefined)}
          onFocus={() => void editorModule.load().catch(() => undefined)}
          onClick={() => setOpen(true)}
        >
          {openLabel}
        </Button>
      </div>
    </div>
  );
}
