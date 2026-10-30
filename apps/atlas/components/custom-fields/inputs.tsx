"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CustomFieldInputs as Inputs } from "./custom-field-inputs";

export type { CustomFieldInputsHandle } from "./custom-field-inputs";

/** The inputs load with the form that shows them, not with the page (A24-009). */
const LazyInputs = dynamic(() => import("./custom-field-inputs").then((m) => m.CustomFieldInputs));

/**
 * A form's custom fields (A117), as forms place them: `<CustomFieldInputs table="app.venues" />`. The inputs follow
 * when their code loads; the action holds the post to required fields either way (lib/custom-fields/form.ts).
 */
export function CustomFieldInputs(props: ComponentProps<typeof Inputs>) {
  return <LazyInputs {...props} />;
}
