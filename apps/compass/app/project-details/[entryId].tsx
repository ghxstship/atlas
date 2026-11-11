import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";
import { ProjectDetailsEntry } from "../../src/screens/ProjectDetails";

/** One roster entry's project details (R5): Travel, Uniform and Vehicle cards for what the project offers. */
export default function ProjectDetailsEntryScreen(): ReactElement {
  const { entryId } = useLocalSearchParams<{ entryId: string }>();
  return <ProjectDetailsEntry entryId={entryId ?? ""} />;
}
