"use client";

import dynamic from "next/dynamic";

/**
 * The editors and review controls of a record's peek and full page (Record template, Section 11.6), loaded when a
 * record is first shown, so no collection route carries their code until a row is open (ADR 0027, as
 * ArchiveControls). They still render on the server with the record, so an open peek shows them at once. All but file
 * review come from record-peek-bundle, one chunk.
 */
export const AssignmentsEditor = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.AssignmentsEditor),
);
export const ChecklistEditor = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.ChecklistEditor),
);
export const DuplicateButton = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.DuplicateButton),
);
export const EditRecordForm = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.EditRecordForm),
);
export const ExtensionForm = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.ExtensionForm),
);
export const RecurrenceForm = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.RecurrenceForm),
);
export const TrashControls = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.TrashControls),
);
export const WatchButton = dynamic(() => import("./record-peek-bundle").then((m) => m.WatchButton));
export const RecordReview = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.RecordReview),
);
/** File review loads on its own, only for a record with files (record-detail renders it only then). */
export const FileReviewControls = dynamic(() =>
  import("@/components/files/file-review").then((m) => m.FileReviewControls),
);
export const ActualsForm = dynamic(() => import("./record-peek-bundle").then((m) => m.ActualsForm));
export const DependencyEditor = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.DependencyEditor),
);
/** Archive and Unarchive, in the same chunk as the rest of a record's controls. */
export const ArchiveControls = dynamic(() =>
  import("./record-peek-bundle").then((m) => m.ArchiveControlsBody),
);
