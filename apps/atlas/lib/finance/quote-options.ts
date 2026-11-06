export interface EngagementOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The client engagements a Draft's form offers. The people picker that fills the list needs capabilities
 * a finance role may lack, and its read can fail, so the engagement the Draft holds is always an option:
 * a native select falls back to its first option, and saving would otherwise clear the client.
 */
export function withCurrentEngagement(
  options: readonly EngagementOption[],
  current: string | null,
  currentLabel: string,
): readonly EngagementOption[] {
  if (current === null || options.some((o) => o.value === current)) return options;
  return [{ value: current, label: currentLabel }, ...options];
}
