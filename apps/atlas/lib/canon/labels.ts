import {
  listCanonRoles,
  listCategories,
  listDepartments,
  listDisciplines,
  listPhases,
  type CanonRole,
  type Category,
  type Department,
  type Discipline,
  type Phase,
} from "@xos/data/canon";
import { listCanonLabels, withCanonLabels, type CanonVocabulary } from "@xos/data/canon-labels";
import type { Result } from "@xos/data/result";
import { getLocale } from "next-intl/server";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Canon labels in the request's language (Section 15, ADR 0053), read once per request through
 * xpms.canon_labels: the translation where one exists, en-US otherwise. Codes are never translated. A failed
 * lookup leaves the English the rows were read with.
 */
export const getCanonLabels = cache(
  async (ctx: OrgContext, vocabulary: CanonVocabulary): Promise<ReadonlyMap<string, string>> => {
    const labels = await listCanonLabels(ctx.viewer.db, vocabulary, await getLocale());
    return labels.ok ? labels.data : new Map();
  },
);

async function relabeled<T>(
  ctx: OrgContext,
  vocabulary: CanonVocabulary,
  rows: Promise<Result<T[]>>,
  code: (row: T) => string,
  apply: (row: T, label: string) => T,
): Promise<Result<T[]>> {
  const [result, labels] = await Promise.all([rows, getCanonLabels(ctx, vocabulary)]);
  return result.ok
    ? { ...result, data: withCanonLabels(result.data, labels, code, apply) }
    : result;
}

/** Departments with their names in the request's language. */
export function localizedDepartments(ctx: OrgContext): Promise<Result<Department[]>> {
  return relabeled(
    ctx,
    "department",
    listDepartments(ctx.viewer.db),
    (d) => d.code,
    (d, name) => ({ ...d, name }),
  );
}

/** Disciplines with their names in the request's language. */
export function localizedDisciplines(ctx: OrgContext): Promise<Result<Discipline[]>> {
  return relabeled(
    ctx,
    "discipline",
    listDisciplines(ctx.viewer.db),
    (d) => d.code,
    (d, name) => ({ ...d, name }),
  );
}

/** Categories with their names in the request's language. */
export function localizedCategories(ctx: OrgContext): Promise<Result<Category[]>> {
  return relabeled(
    ctx,
    "category",
    listCategories(ctx.viewer.db),
    (c) => c.urid,
    (c, name) => ({ ...c, name }),
  );
}

/** Phases with their names in the request's language. */
export function localizedPhases(ctx: OrgContext): Promise<Result<Phase[]>> {
  return relabeled(
    ctx,
    "phase",
    listPhases(ctx.viewer.db),
    (p) => p.code,
    (p, name) => ({ ...p, name }),
  );
}

/** Workforce roles (Bible tab 27) with their names in the request's language. */
export function localizedCanonRoles(ctx: OrgContext): Promise<Result<CanonRole[]>> {
  return relabeled(
    ctx,
    "role",
    listCanonRoles(ctx.viewer.db),
    (r) => r.code,
    (r, name) => ({ ...r, name }),
  );
}
