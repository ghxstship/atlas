import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Per-person sandboxes (Section 11.7, A65-022, migration 1530): a private Northwind Live org filled from the sandbox
 * template, ending 14 days after it opens. The database decides everything: who may open one, that it is never
 * billed, sends no email or SMS and lets nobody else in, and when it is purged.
 */

export interface Sandbox {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  /** The instant the sandbox ends; the hourly purge removes it after this. */
  readonly expiresAt: string;
}

interface SandboxRow {
  org_id: string;
  slug: string;
  name: string;
  expires_at: string;
}

const toSandbox = (row: SandboxRow): Sandbox => ({
  orgId: row.org_id,
  slug: row.slug,
  name: row.name,
  expiresAt: row.expires_at,
});

/** The signed-in person's open sandbox, or null when they have none. */
export async function getMySandbox(db: XosClient): Promise<Result<Sandbox | null>> {
  const { data, error } = await db.rpc("my_sandbox");
  if (error) return fail(toDataError(error));
  const row = ((data ?? []) as SandboxRow[])[0];
  return ok(row ? toSandbox(row) : null);
}

/** Opens the person's sandbox: their open one, or a new one filled from the template. */
export async function openMySandbox(db: XosClient): Promise<Result<Sandbox>> {
  const { data, error } = await db.rpc("open_my_sandbox");
  if (error) return fail(toDataError(error));
  const row = ((data ?? []) as SandboxRow[])[0];
  return row
    ? ok(toSandbox(row))
    : fail({ kind: "unexpected", message: "The sandbox did not open." });
}

/** When an org the person belongs to is their sandbox, the instant it ends; null for any other org. */
export async function sandboxEnds(db: XosClient, orgId: string): Promise<Result<string | null>> {
  const { data, error } = await db
    .from("sandbox_orgs")
    .select("expires_at")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data?.expires_at ?? null);
}
