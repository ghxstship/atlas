"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { assignShiftAction, rankCandidatesAction } from "@/app/[org]/crew/scheduling-actions";
import { SHIFT_MIME } from "./shift-drop-mime";

/**
 * The reverse of the board's drag (B4, G-43): an open shift dragged from the board onto a person's lane of the
 * resource schedule. The drop ranks that shift first, as the board's own drop does, so a person on an overlapping
 * shift is warned of and not assigned (A132's rule, ADR 0063 item 5); otherwise the shift goes to them through
 * assignShiftAction and the outcome is announced. The keyboard path stays the board's: choose the shift, then press
 * Assign on a ranked person. Loaded on demand (lazy-scheduling.tsx), and it listens on the schedule's table, whose
 * person rows carry data-shift-drop with their membership.
 */
export function ShiftDropIsland({
  org,
  weekStart,
  gridId,
}: {
  org: string;
  weekStart: string;
  gridId: string;
}) {
  const t = useTranslations("crew.scheduling");
  const router = useRouter();
  const [announcement, setAnnouncement] = useState("");
  const busy = useRef(false);

  useEffect(() => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const rowOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("tr[data-shift-drop]") : null;
    const clear = () =>
      grid
        .querySelectorAll("tr[data-drop-over]")
        .forEach((r) => r.removeAttribute("data-drop-over"));
    const onOver = (event: DragEvent) => {
      const row = rowOf(event.target);
      if (!row || !event.dataTransfer?.types.includes(SHIFT_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clear();
      row.setAttribute("data-drop-over", "");
    };
    const onDrop = (event: DragEvent) => {
      const row = rowOf(event.target);
      const raw = event.dataTransfer?.getData(SHIFT_MIME);
      clear();
      if (!row || !raw || busy.current) return;
      event.preventDefault();
      const membershipId = row.dataset["shiftDrop"] ?? "";
      const name = row.dataset["shiftDropName"] ?? "";
      let shift: { id: string; label: string };
      try {
        shift = JSON.parse(raw) as { id: string; label: string };
      } catch {
        return;
      }
      busy.current = true;
      void (async () => {
        const ranked = await rankCandidatesAction(org, shift.id, weekStart);
        if (!ranked.ok) {
          setAnnouncement(t("assignFailed", { name, error: ranked.error }));
          busy.current = false;
          return;
        }
        const there = ranked.candidates.find((c) => c.membershipId === membershipId);
        if (!there || there.conflict) {
          setAnnouncement(
            t(there ? "laneConflict" : "dropNotRanked", { name, shift: shift.label }),
          );
          busy.current = false;
          return;
        }
        const outcome = await assignShiftAction(org, shift.id, membershipId);
        busy.current = false;
        if (!outcome.ok) {
          setAnnouncement(t("assignFailed", { name, error: outcome.error ?? "" }));
          return;
        }
        setAnnouncement(t("laneAssigned", { name, shift: shift.label }));
        router.refresh();
      })();
    };
    const onLeave = (event: DragEvent) => {
      if (!grid.contains(event.relatedTarget as Node | null)) clear();
    };
    grid.addEventListener("dragover", onOver);
    grid.addEventListener("drop", onDrop);
    grid.addEventListener("dragleave", onLeave);
    return () => {
      grid.removeEventListener("dragover", onOver);
      grid.removeEventListener("drop", onDrop);
      grid.removeEventListener("dragleave", onLeave);
    };
  }, [gridId, org, weekStart, t, router]);

  return (
    <p aria-live="polite" className="sr-only" data-testid="shift-drop-announcement">
      {announcement}
    </p>
  );
}
