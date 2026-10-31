"use client";

import type { LibrarySegment } from "@xos/data/segment-library";
import type { Cue, RunOfShow } from "@xos/data/show";
import { Button, Dialog, Input, Select } from "@xos/ui";
import { useEffect, useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import type { ActionError } from "@/components/work/action-result";
import { fromLocalInput } from "@/components/work/format";
import { insertLibrarySegmentAction, listLibrarySegmentsAction } from "./depth-actions";

/**
 * Insert segment (B3, G-73, ADR 0142): copies a library segment's cues and department calls into the running
 * order at a place after the last called cue, optionally planned from a start time. runs.tsx loads it with
 * next/dynamic when someone opens it. The database renumbers the run and refuses a place at or before the last
 * called cue or a run past 300 cues.
 */
export function InsertSegmentDialog({
  org,
  run,
  cues,
  onClose,
}: {
  org: string;
  run: RunOfShow;
  cues: readonly Cue[];
  onClose: () => void;
}) {
  const t = useCopy("show");
  const insert = useAction();
  const [segments, setSegments] = useState<readonly LibrarySegment[] | null>(null);
  const [loadError, setLoadError] = useState<ActionError | null>(null);
  const [segmentId, setSegmentId] = useState("");
  const [place, setPlace] = useState("");
  const [start, setStart] = useState("");

  useEffect(() => {
    void listLibrarySegmentsAction(org).then((result) => {
      if (result.ok) {
        setSegments(result.data);
        setSegmentId(result.data[0]?.id ?? "");
      } else {
        setLoadError(result.error);
      }
    });
  }, [org]);

  const lastCalled = cues.reduce((last, c, i) => (c.calledAt ? i + 1 : last), 0);
  const places = [
    ...cues
      .map((c, i) => ({
        value: String(i + 1),
        label: t("segmentLibrary.before", { n: i + 1, label: c.label }),
      }))
      .filter((o) => Number(o.value) > lastCalled),
    { value: "", label: t("segmentLibrary.atEnd") },
  ];

  return (
    <Dialog
      title={t("segmentLibrary.insertTitle", { name: run.name })}
      description={t("segmentLibrary.insertBody")}
      open
      onOpenChange={(v) => (v ? undefined : onClose())}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cues.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={insert.pending}
            disabled={segmentId === ""}
            onClick={() =>
              insert.run(
                () =>
                  insertLibrarySegmentAction(org, {
                    runId: run.id,
                    segmentId,
                    beforePosition: place === "" ? null : Number(place),
                    startsAt: start
                      ? fromLocalInput(`${run.showDate}T${start}`, run.timeZone)
                      : null,
                  }),
                onClose,
              )
            }
          >
            {t("segmentLibrary.insertConfirm")}
          </Button>
        </>
      }
    >
      <ActionErrorAlert error={loadError ?? insert.error} />
      {segments && segments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("segmentLibrary.emptyLibrary")}</p>
      ) : (
        <div className="flex flex-col gap-12">
          <Select
            id={`segment-insert-${run.id}`}
            label={t("segmentLibrary.segment")}
            value={segmentId}
            options={(segments ?? []).map((s) => ({
              value: s.id,
              label: t("segmentLibrary.option", { name: s.name, count: s.cueCount }),
            }))}
            onChange={(e) => setSegmentId(e.target.value)}
          />
          <Select
            id={`segment-insert-place-${run.id}`}
            label={t("segmentLibrary.place")}
            value={place}
            options={places}
            onChange={(e) => setPlace(e.target.value)}
          />
          <Input
            id={`segment-insert-start-${run.id}`}
            type="time"
            label={t("segmentLibrary.start")}
            help={t("segmentLibrary.startHelp")}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
      )}
    </Dialog>
  );
}
