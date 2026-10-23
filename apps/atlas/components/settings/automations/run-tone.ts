/** The tag tone of an automation run or step status (A91). */
export type RunTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function runTone(status: string): RunTone {
  if (status === "Succeeded") return "success";
  if (status === "Failed") return "danger";
  if (status === "Retrying") return "warning";
  if (status === "Running" || status === "Queued") return "accent";
  return "neutral";
}
