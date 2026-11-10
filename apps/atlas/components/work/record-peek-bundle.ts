/**
 * Everything record-peek-panels loads, in one module so it arrives as one chunk: a record page that shows them all
 * makes one request rather than one per editor, and their shared code is not repeated across chunks.
 */
export {
  AssignmentsEditor,
  ChecklistEditor,
  DuplicateButton,
  EditRecordForm,
  ExtensionForm,
  RecurrenceForm,
  TrashControls,
  WatchButton,
} from "./record-panels";
export { RecordReview } from "./record-review";
export { ActualsForm, DependencyEditor } from "@/components/schedule/schedule-panels";
export { ArchiveControlsBody } from "@/components/archive/archive-controls-body";
