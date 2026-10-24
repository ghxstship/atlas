/**
 * The workspace filter (Section 4.5.1): a person narrows Atlas to one workspace of the org. Kept per
 * device in a cookie until saved views and personal defaults (A30, A31) hold it.
 */
export const WORKSPACE_COOKIE = "xos-workspace";

/**
 * The workspace the filter cookie chose, when it names one of the org's workspaces; null (the whole org)
 * otherwise. Workspace values of settings (Section 4.5.6) apply inside it.
 */
export function chosenWorkspace<W extends { readonly slug: string }>(
  workspaces: readonly W[],
  cookie: string | null | undefined,
): W | null {
  return workspaces.find((w) => w.slug === cookie) ?? null;
}
