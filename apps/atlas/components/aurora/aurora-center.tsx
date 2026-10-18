"use client";

import { IconButton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

const AURORA_EVENT = "xos:aurora";

/** The panel and the AI client load the first time the person opens Aurora (A24-009). */
const panel = onDemand(() => import("./aurora-panel"));

/** Opens the Aurora panel from anywhere in Atlas. */
export function openAurora() {
  window.dispatchEvent(new CustomEvent(AURORA_EVENT));
}

export interface AuroraCenterProps {
  readonly org: string;
  /** Whether the viewer can turn AI features on (org.ai.write), for the "off" state's next step. */
  readonly canManage: boolean;
}

/**
 * Aurora in the Atlas shell (Section 4.7). The Ask Aurora button and Cmd or Ctrl+J open the
 * assistant in a side panel. It talks only to the public API with the person's own session, so it
 * sees and does no more than they can; every answer carries the AI-generated label (EU AI Act
 * Article 50), and every change it proposes waits on a confirmation step that shows what changes.
 */
export function AuroraCenter({ org, canManage }: AuroraCenterProps) {
  const t = useTranslations("aurora");
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const loaded = useOnDemand(panel, opened);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setOpened(true);
        setOpen((o) => !o);
      }
    };
    const onOpen = () => {
      setOpened(true);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(AURORA_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(AURORA_EVENT, onOpen);
    };
  }, []);

  const preload = () => void panel.load().catch(() => undefined);

  return (
    <>
      <IconButton
        icon="Sparkles"
        label={t("panel.button")}
        shortcut="Mod+J"
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
