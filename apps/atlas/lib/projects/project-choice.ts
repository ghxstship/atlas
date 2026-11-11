/**
 * The project a create form starts on (crawl 4.9). A form never picks the first of several projects by itself: the
 * project list holds every project the person can read, including ones they only see through a shift, where saving
 * is refused. It starts on the project the page is scoped to, else on the only project, else on none, and the
 * select then leads with "Choose a project" so the person picks one. Client and server safe.
 */

export interface ProjectChoice {
  readonly id: string;
}

/** The preferred project when it is one of the list, else the only project, else none (""). */
export function initialProjectId(
  projects: readonly ProjectChoice[],
  preferred?: string | null,
): string {
  if (preferred && projects.some((p) => p.id === preferred)) return preferred;
  return projects.length === 1 ? (projects[0]?.id ?? "") : "";
}

/** The select's options: "Choose a project" first while there are several to choose from. */
export function projectChoiceOptions(
  options: ReadonlyArray<{ value: string; label: string }>,
  chooseLabel: string,
): Array<{ value: string; label: string }> {
  return options.length > 1 ? [{ value: "", label: chooseLabel }, ...options] : [...options];
}
