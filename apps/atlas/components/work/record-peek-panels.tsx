"use client";

import dynamic from "next/dynamic";

/**
 * The editors and review controls of a record's peek and full page (Record template, Section 11.6), loaded when a
 * record is first shown, so no collection route carries their code until a row is open (ADR 0027, as
 * ArchiveControls). They still render on the server with the record, so an open peek shows them at once.
 */
export const AssignmentsEditor = dynamic(() =>
  import("./record-panels").then((m) => m.AssignmentsEditor),
);
export const ChecklistEditor = dynamic(() =>
  import("./record-panels").then((m) => m.ChecklistEditor),
);
export const DuplicateButton = dynamic(() =>
  import("./record-panels").then((m) => m.DuplicateButton),
);
export const EditRecordForm = dynamic(() =>
  import("./record-panels").then((m) => m.EditRecordForm),
);
export const ExtensionForm = dynamic(() => import("./record-panels").then((m) => m.ExtensionForm));
export const RecurrenceForm = dynamic(() =>
  import("./record-panels").then((m) => m.RecurrenceForm),
);
export const TrashControls = dynamic(() => import("./record-panels").then((m) => m.TrashControls));
export const WatchButton = dynamic(() => import("./record-panels").then((m) => m.WatchButton));
export const RecordReview = dynamic(() => import("./record-review").then((m) => m.RecordReview));
export const FileReviewControls = dynamic(() =>
  import("@/components/files/file-review").then((m) => m.FileReviewControls),
);
export const ActualsForm = dynamic(() =>
  import("@/components/schedule/schedule-panels").then((m) => m.ActualsForm),
);
export const DependencyEditor = dynamic(() =>
  import("@/components/schedule/schedule-panels").then((m) => m.DependencyEditor),
);
