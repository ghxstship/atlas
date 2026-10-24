"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { CUSTOM_FIELD_SHOWN } from "@/lib/custom-fields/names";
import type { CustomFieldInputs as Inputs } from "./custom-field-inputs";

export type { CustomFieldInputsHandle } from "./custom-field-inputs";

/** The inputs load with the form that shows them, not with the page (A24-009). */
const LazyInputs = dynamic(() => import("./custom-field-inputs").then((m) => m.CustomFieldInputs));

/**
 * A form's custom fields (A117), as forms place them: `<CustomFieldInputs table="app.venues" />`. The marker that
 * holds the action to required fields is there from the first paint; the inputs follow when their code loads.
 */
export function CustomFieldInputs(props: ComponentProps<typeof Inputs>) {
  return (
    <>
      <input type="hidden" name={CUSTOM_FIELD_SHOWN} value="1" />
      <LazyInputs {...props} />
    </>
  );
}
