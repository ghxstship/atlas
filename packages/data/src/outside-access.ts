import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The Outside access section of Project Settings (B2, ADR 0141; migration 2917). The view is a union in
 * which each source's own row level security and column grants decide; always filtered by project,
 * since a file link's project is looked up per row. Nothing here is a code or token: XOS stores none
 * readably.
 */

export const OUTSIDE_ACCESS_SOURCES = [
  "Live view link",
  "Display link",
  "File link",
  "Advance link",
  "Signing link",
  "Roster invitation",
  "Pack recipient",
  "Intake link",
  "Form link",
  "Engagement",
] as const;

export type OutsideAccessSource = (typeof OUTSIDE_ACCESS_SOURCES)[number];

export interface OutsideAccessRow {
  readonly source: OutsideAccessSource;
  readonly sourceId: string;
  readonly label: string;
  readonly recipientEmail: string | null;
  readonly tokenHint: string | null;
  readonly state: string;
  readonly expiresAt: string | null;
  readonly openCount: number | null;
  readonly lastOpenedAt: string | null;
  readonly createdAt: string;
}

export async function listOutsideAccess(
  db: XosClient,
  projectId: string,
): Promise<Result<OutsideAccessRow[]>> {
  const { data, error } = await db
    .from("project_outside_access")
    .select(
      "source, source_id, label, recipient_email, token_hint, link_state, expires_at, open_count, last_opened_at, created_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    source: OutsideAccessSource;
    source_id: string;
    label: string;
    recipient_email: string | null;
    token_hint: string | null;
    link_state: string;
    expires_at: string | null;
    open_count: number | null;
    last_opened_at: string | null;
    created_at: string;
  }[];
  return ok(
    rows.map((r) => ({
      source: r.source,
      sourceId: r.source_id,
      label: r.label,
      recipientEmail: r.recipient_email,
      tokenHint: r.token_hint,
      state: r.link_state,
      expiresAt: r.expires_at,
      openCount: r.open_count,
      lastOpenedAt: r.last_opened_at,
      createdAt: r.created_at,
    })),
  );
}

/** Grouped by source, in the fixed order the section shows them. */
export function groupOutsideAccess(
  rows: readonly OutsideAccessRow[],
): readonly { readonly source: OutsideAccessSource; readonly rows: readonly OutsideAccessRow[] }[] {
  return OUTSIDE_ACCESS_SOURCES.map((source) => ({
    source,
    rows: rows.filter((r) => r.source === source),
  })).filter((g) => g.rows.length > 0);
}
