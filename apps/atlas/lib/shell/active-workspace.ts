import { listWorkspaces, type Workspace, type XosClient } from "@xos/data";
import { cookies } from "next/headers";
import { cache } from "react";
import { WORKSPACE_COOKIE, chosenWorkspace } from "./workspace";

export interface OrgWorkspaces {
  readonly all: readonly Workspace[];
  /** The workspace this device's filter chose, or null for the whole org. */
  readonly active: Workspace | null;
}

/**
 * An org's workspaces and the one the workspace filter cookie chose, once per request: the shell, the entry
 * page's start page and locale negotiation resolve settings in the same workspace.
 */
export const getOrgWorkspaces = cache(
  async (db: XosClient, orgId: string): Promise<OrgWorkspaces> => {
    const [workspaces, store] = await Promise.all([listWorkspaces(db, orgId), cookies()]);
    if (!workspaces.ok) {
      throw new Error(`Cannot list workspaces: ${JSON.stringify(workspaces.error)}`);
    }
    return {
      all: workspaces.data,
      active: chosenWorkspace(workspaces.data, store.get(WORKSPACE_COOKIE)?.value),
    };
  },
);
