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
  // Gate 27 cognitive load (finding A47-002): screens with more than one primary action.
  ...(
    [
      [["anonymous"], ["/auth/sign-in", "/auth/sign-up"]],
      [
        ["crew", "vendor"],
        ["home", "profile", "settings", "settings.profile"],
      ],
      [["vendor"], ["explore", "messages"]],
    ] as const
  ).map(([roles, routes]) => ({
    finding: "A47-002",
    pattern: /^cognitive load: \d+ primary actions/,
    roles,
    routes,
  })),

  // Gate 27 cognitive load (finding A47-002): forms with more than 7 visible fields.
  {
    finding: "A47-002",
    pattern: /^cognitive load: \d+ visible fields/,
    roles: ["crew", "vendor"],
    routes: ["explore", "settings.profile-privacy"],
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
