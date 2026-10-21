"use client";

import { IconButton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

const AURORA_EVENT = "xos:aurora";

/** The panel and the AI client load the first time the person opens Aurora (A24-009). */
const panel = onDemand(() => import("./aurora-panel"));

/** Opens the Aurora panel from anywhere in Atlas; `toggle` closes it when it is open. */
export function openAurora(toggle = false) {
  window.dispatchEvent(new CustomEvent(AURORA_EVENT, { detail: toggle }));
}

export interface AuroraCenterProps {
  readonly org: string;
  /** Whether the viewer can turn AI features on (org.ai.write), for the "off" state's next step. */
  readonly canManage: boolean;
  /** The person's keys for Aurora as they read them, for the button's tooltip. */
  readonly shortcut?: string | undefined;
}

/**
 * Aurora in the Atlas shell (Section 4.7). The Ask Aurora button and its shortcut (Cmd or Ctrl+J by
 * default; the shell's key handler sends openAurora(true)) open the assistant in a side panel. It talks only to the public API with the person's own session, so it
 * sees and does no more than they can; every answer carries the AI-generated label (EU AI Act
 * Article 50), and every change it proposes waits on a confirmation step that shows what changes.
 */
export function AuroraCenter({ org, canManage, shortcut }: AuroraCenterProps) {
  const t = useTranslations("aurora");
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const loaded = useOnDemand(panel, opened);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const toggle = (event as CustomEvent<boolean>).detail === true;
      setOpened(true);
      setOpen((o) => (toggle ? !o : true));
    };
    window.addEventListener(AURORA_EVENT, onOpen);
    return () => window.removeEventListener(AURORA_EVENT, onOpen);
  }, []);

  const preload = () => void panel.load().catch(() => undefined);

  return (
    <>
      <IconButton
        icon="Sparkles"
        label={t("panel.button")}
        {...(shortcut ? { shortcut } : {})}
        data-aurora-trigger=""
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
      />
      {loaded ? (
        <loaded.AuroraPanel org={org} canManage={canManage} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
