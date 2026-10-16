import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Shared plumbing of the workforce suite repositories (A29, Section 4.9, migrations 0800 to 0807
 * and 1010): row mapping helpers, a read runner and an RPC runner that turn database errors into
 * typed repository errors. Every module maps rows into declared interfaces at the boundary.
 */

export type Raw = Record<string, unknown>;
type Query = PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;

export const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
export const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
export const bool = (v: unknown): boolean => v === true;
export const obj = (v: unknown): Raw | null =>
  Array.isArray(v) ? ((v[0] as Raw | undefined) ?? null) : ((v as Raw | null) ?? null);
export const list = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Runs a read and maps every row. */
export async function rows<T>(query: Query, map: (row: Raw) => T): Promise<Result<T[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(((data as Raw[] | null) ?? []).map(map));
}

/** Runs a single-row read; no row is not-found. */
export async function single<T>(query: Query, map: (row: Raw) => T): Promise<Result<T>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  if (data === null || data === undefined) return fail({ kind: "not-found" });
  return ok(map(data as Raw));
}

/** Calls an RPC with named arguments and returns its value as is. */
export async function call<T>(db: XosClient, fn: string, args: Raw): Promise<Result<T>> {
  const { data, error } = await untyped(db).rpc(fn, args);
  return error ? fail(toDataError(error)) : ok(data as T);
}

/** Calls an RPC that returns an id and wraps it as `{ id }`, which the Atlas actions open. */
export async function callId(
  db: XosClient,
  fn: string,
  args: Raw,
): Promise<Result<{ id: string }>> {
  const result = await call<string>(db, fn, args);
  return result.ok ? ok({ id: str(result.data) }) : result;
}

/** Calls a set-returning RPC and maps every row. */
export async function callRows<T>(
  db: XosClient,
  fn: string,
  args: Raw,
  map: (row: Raw) => T,
): Promise<Result<T[]>> {
  return rows(untyped(db).rpc(fn, args), map);
}

/** Drops undefined values so optional RPC arguments fall back to their database defaults. */
export function args(values: Readonly<Record<string, unknown>>): Raw {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/** Who a feed post, survey or event reaches (app.audience_kind). */
export type AudienceKind = "Organization" | "Project" | "Team" | "Role" | "Group";
export const AUDIENCE_KINDS: readonly AudienceKind[] = [
  "Organization",
  "Project",
  "Team",
  "Role",
  "Group",
];

export interface Audience {
  readonly kind: AudienceKind;
  readonly projectId: string | null;
  readonly teamId: string | null;
  readonly roleId: string | null;
  readonly groupId: string | null;
}

export function audienceOf(r: Raw): Audience {
  return {
    kind: str(r["audience_kind"]) as AudienceKind,
    projectId: strOrNull(r["project_id"]),
    teamId: strOrNull(r["team_id"]),
    roleId: strOrNull(r["role_id"]),
    groupId: strOrNull(r["group_id"]),
  };
}

/** The RPC arguments of an audience. */
export function audienceArgs(a: Partial<Audience> | undefined): Raw {
  return args({
    p_audience_kind: a?.kind,
    p_project_id: a?.projectId ?? undefined,
    p_team_id: a?.teamId ?? undefined,
    p_role_id: a?.roleId ?? undefined,
    p_group_id: a?.groupId ?? undefined,
  });
}

/** The table columns of an audience, for direct inserts. */
export function audienceColumns(a: Partial<Audience> | undefined): Raw {
  return {
    audience_kind: a?.kind ?? "Organization",
    project_id: a?.projectId ?? null,
    team_id: a?.teamId ?? null,
    role_id: a?.roleId ?? null,
    group_id: a?.groupId ?? null,
  };
}

/** A person's display name from an embedded membership with its person. */
export function memberName(v: unknown): string | null {
  const m = obj(v);
  const p = obj(m?.["person"]);
  return strOrNull(p?.["full_name"]);
}

export const MEMBER_EMBED = "id, person_id, person:people!memberships_person_id_fkey(full_name)";
