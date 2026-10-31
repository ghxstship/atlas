import type { ReactElement } from "react";
import { ProjectDetailsList } from "../src/screens/ProjectDetails";

/** The project-details More screen (R5): the person's live roster entries, each opening its project details. */
export default function ProjectDetailsScreen(): ReactElement {
  return <ProjectDetailsList />;
}
