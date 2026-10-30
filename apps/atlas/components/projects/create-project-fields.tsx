"use client";

import type { ComponentProps } from "react";
import { CustomFieldInputs } from "@/components/custom-fields/inputs";
import { ProjectFields } from "./project-fields";

/** The New project drawer's fields and the org's project custom fields (A117), loaded when it first opens. */
export function CreateProjectFields(props: ComponentProps<typeof ProjectFields>) {
  return (
    <>
      <ProjectFields {...props} />
      <CustomFieldInputs table="app.projects" />
    </>
  );
}
