/**
 * Inspections (Section 4.3 item 6, Section 11.13 Inspections): template-driven walks, one item per card,
 * large Pass and Fail, a Fail asks for a photo and a note, then sign-off by someone other than the inspector.
 * Results use the canon Inspection Result enumeration; checklist items are rows, never array positions.
 */
import { uuidv7, type MutationInput } from "@xos/sync";

export interface InspectionItem {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly is_critical: boolean;
}

/** A row of the canon Inspection Result enumeration. */
export interface ResultValue {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly sortOrder: number;
}

/** The two big buttons map to canon codes; other canon values are in the overflow. */
export const PASS_CODE = "INSP_PASSED";
export const FAIL_CODE = "INSP_FAILED";
export const CONDITIONAL_CODE = "INSP_CONDITIONAL";

export interface ItemAnswer {
  readonly resultId: string;
  readonly note: string;
  readonly photoUri: string | null;
  readonly answeredAt: number;
}

export interface Walk {
  readonly inspectionId: string;
  readonly templateId: string;
  readonly projectId: string;
  readonly items: readonly InspectionItem[];
  readonly answers: Readonly<Record<string, ItemAnswer>>;
  readonly index: number;
  readonly startedAt: number;
}

export function startWalk(
  templateId: string,
  projectId: string,
  items: readonly InspectionItem[],
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): Walk {
  return {
    inspectionId: newId(nowMs),
    templateId,
    projectId,
    items: [...items].sort((a, b) => a.position - b.position),
    answers: {},
    index: 0,
    startedAt: nowMs,
  };
}

export type AnswerProblem = "photo-required" | "note-required" | "unknown-result";

/** A failing or conditional answer needs a photo and a note before the walk moves on. */
export function answerProblems(
  answer: ItemAnswer,
  values: readonly ResultValue[],
): AnswerProblem[] {
  const value = values.find((v) => v.id === answer.resultId);
  if (!value) return ["unknown-result"];
  if (value.code !== FAIL_CODE && value.code !== CONDITIONAL_CODE) return [];
  const problems: AnswerProblem[] = [];
  if (!answer.photoUri) problems.push("photo-required");
  if (answer.note.trim().length === 0) problems.push("note-required");
  return problems;
}

export function answer(
  walk: Walk,
  itemId: string,
  value: ItemAnswer,
  values: readonly ResultValue[],
): Walk {
  const problems = answerProblems(value, values);
  if (problems.length > 0) throw new Error(`answer is not complete: ${problems.join(", ")}`);
  const answers = { ...walk.answers, [itemId]: value };
  const nextIndex = walk.items.findIndex((item) => !answers[item.id]);
  return { ...walk, answers, index: nextIndex === -1 ? walk.items.length : nextIndex };
}

export function goTo(walk: Walk, index: number): Walk {
  return { ...walk, index: Math.max(0, Math.min(index, walk.items.length - 1)) };
}

export function currentItem(walk: Walk): InspectionItem | null {
  return walk.items[walk.index] ?? null;
}

export function progress(walk: Walk): { readonly done: number; readonly total: number } {
  return { done: walk.items.filter((i) => walk.answers[i.id]).length, total: walk.items.length };
}

export function isComplete(walk: Walk): boolean {
  const { done, total } = progress(walk);
  return total > 0 && done === total;
}

/** Average seconds per answered item (target under 5 s, Section 11.13). */
export function averageSecondsPerItem(walk: Walk): number | null {
  const times = Object.values(walk.answers)
    .map((a) => a.answeredAt)
    .sort((a, b) => a - b);
  if (times.length === 0) return null;
  const last = times.at(-1) ?? walk.startedAt;
  return (last - walk.startedAt) / 1000 / times.length;
}

/** Failed critical items: a failure that stops use is called out before submit. */
export function criticalFailures(walk: Walk, values: readonly ResultValue[]): InspectionItem[] {
  const fail = new Set(values.filter((v) => v.code === FAIL_CODE).map((v) => v.id));
  return walk.items.filter((i) => i.is_critical && fail.has(walk.answers[i.id]?.resultId ?? ""));
}

/** The queued writes: the inspection, then one result row per item, each depending on the inspection. */
export function buildInspection(
  walk: Walk,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput[] {
  if (!isComplete(walk)) throw new Error("every item needs an answer before submit");
  const inspection = {
    id: walk.inspectionId,
    project_id: walk.projectId,
    inspection_template_id: walk.templateId,
    inspected_at: new Date(walk.startedAt).toISOString(),
  };
  const writes: MutationInput[] = [
    {
      op: "insert",
      table: "inspections",
      rowId: walk.inspectionId,
      payload: inspection,
      policy: "append",
      optimistic: inspection,
    },
  ];
  for (const item of walk.items) {
    const a = walk.answers[item.id];
    if (!a) continue;
    const id = newId(nowMs);
    const row = {
      id,
      inspection_id: walk.inspectionId,
      project_id: walk.projectId,
      inspection_item_id: item.id,
      result_enum_id: a.resultId,
      note: a.note.trim() || null,
      photo_uri: a.photoUri,
    };
    writes.push({
      op: "insert",
      table: "inspection_results",
      rowId: id,
      payload: row,
      policy: "append",
      optimistic: row,
    });
  }
  return writes;
}

/** Sign-off needs the capability and is never by the inspector (mirrors private.guard_inspection). */
export function canSignOff(
  inspection: {
    readonly inspector_person_id: string | null;
    readonly signed_off_at: string | null;
  },
  personId: string,
  hasCapability: boolean,
): "allowed" | "already-signed" | "own-inspection" | "capability" {
  if (inspection.signed_off_at !== null) return "already-signed";
  if (!hasCapability) return "capability";
  if (inspection.inspector_person_id === personId) return "own-inspection";
  return "allowed";
}

export function buildSignOff(inspectionId: string, nowMs: number): MutationInput {
  return {
    op: "update",
    table: "inspections",
    rowId: inspectionId,
    payload: { signed_off_at: new Date(nowMs).toISOString() },
    policy: "guarded",
  };
}
