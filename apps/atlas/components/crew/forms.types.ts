import type { CrewActionState } from "@/lib/crew/action-state";

/**
 * The form kit for People and Crew: a field-spec form inside a Drawer for create and edit
 * (`?create=1`, `?edit=<id>`), and a confirm button that asks for the reason every state change
 * carries (Section 3.12). Server actions decide every write; a refusal shows its rule in words and the
 * typed input stays in place.
 */

export type FieldSpec =
  | {
      readonly kind: "text" | "date" | "datetime" | "number" | "money";
      readonly name: string;
      readonly label: string;
      readonly value?: string;
      readonly required?: boolean;
      readonly help?: string;
      readonly step?: string;
      readonly min?: string;
    }
  | {
      readonly kind: "textarea";
      readonly name: string;
      readonly label: string;
      readonly value?: string;
      readonly required?: boolean;
      readonly help?: string;
    }
  | {
      readonly kind: "select";
      readonly name: string;
      readonly label: string;
      readonly value?: string;
      readonly options: ReadonlyArray<{ value: string; label: string }>;
      readonly help?: string;
    }
  | { readonly kind: "hidden"; readonly name: string; readonly value: string };

export type Action = (state: CrewActionState, form: FormData) => Promise<CrewActionState>;
