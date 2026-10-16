/**
 * Problems with an open A23 finding (legal/accessibility/findings/A23-NNN.md). A problem that
 * matches an entry is reported as an annotation instead of failing the route, so the sweep stays
 * green while the finding is open. An entry that names its routes must still reproduce on each of
 * them: when it stops reproducing the route fails with "no longer reproduces", which is the signal
 * that the fix landed and the entry should be deleted. Entries without routes apply everywhere.
 *
 * `viewports` and `roles` limit an entry to those Playwright projects and roles.
 */
export interface KnownProblem {
  readonly finding: string;
  readonly pattern: RegExp;
  readonly routes?: readonly string[];
  readonly viewports?: readonly string[];
  readonly roles?: readonly string[];
}

export const KNOWN_PROBLEMS: readonly KnownProblem[] = [
  { finding: "A23-011", pattern: /^focus: first stop is .*, not a skip link$/ },
  {
    finding: "A23-015",
    pattern: /axe scrollable-region-focusable/,
    routes: ["schedule.timeline", "project.schedule", "projects.portfolio-timeline"],
    viewports: ["phone-375"],
    roles: ["owner", "manager", "field"],
  },
  {
    finding: "A23-017",
    pattern: /^structure: the page has no visible h1$|^status: .* answered 500$/,
    routes: ["project", "project.overview"],
    roles: ["field"],
  },
  {
    finding: "A23-016",
    pattern: /^icon control: "Open navigation" has no tooltip$/,
    viewports: ["phone-375"],
  },
];

export interface Triage {
  readonly open: string[];
  readonly known: string[];
}

/** Splits a route's problems into open ones (fail) and ones an open finding already covers. */
export function triage(
  problems: readonly string[],
  where: { route: string; project: string; role: string },
  known: readonly KnownProblem[] = KNOWN_PROBLEMS,
): Triage {
  const applies = known.filter(
    (k) =>
      (!k.routes || k.routes.includes(where.route)) &&
      (!k.viewports || k.viewports.includes(where.project)) &&
      (!k.roles || k.roles.includes(where.role)),
  );
  const open: string[] = [];
  const knownOut: string[] = [];
  for (const problem of problems) {
    const hit = applies.find((k) => k.pattern.test(problem));
    if (hit) knownOut.push(`${hit.finding}: ${problem}`);
    else open.push(problem);
  }
  for (const k of applies) {
    if (k.routes && !problems.some((p) => k.pattern.test(p))) {
      open.push(`${k.finding} no longer reproduces here; delete its entry in known.ts`);
    }
  }
  return { open, known: knownOut };
}
