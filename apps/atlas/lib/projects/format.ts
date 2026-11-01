import type { PhaseCode, RecordState } from "@xos/ui";
import type { ProductionState, ProjectState } from "@xos/data/projects";

/**
 * The state icon a project or production state shows. The lifecycles use the shared state
 * vocabulary (Section 3.10), so each value maps to the record state icon of the same name; Closed,
 * the production extension, shows as Complete with its own label.
 */
export function stateIcon(state: ProjectState | ProductionState): RecordState {
  switch (state) {
    case "Proposed":
      return "proposed";
    case "Active":
      return "active";
    case "Blocked":
      return "blocked";
    case "Complete":
    case "Closed":
      return "complete";
    case "Canceled":
      return "canceled";
  }
}

/** A canon phase code as the design system's phase code type; canon holds exactly these nine. */
export function phaseCode(code: string): PhaseCode {
  return code as PhaseCode;
}

/** An enum display value to its catalog key: `Engagement Root` to `engagementRoot`. */
export function enumKey(value: string): string {
  return value
    .split(" ")
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`,
    )
    .join("");
}

/** `G1.BUDGET_ENVELOPE` to the catalog key segment `G1_BUDGET_ENVELOPE`. */
export function criterionKey(criterionId: string): string {
  return criterionId.replace(/\./g, "_");
}
