import type { FormResult } from "@/lib/actions/operations";

/**
 * The token adapter (R10): the Advance tab's typed forms (components/engagement/advance-forms.tsx)
 * post to signed-in actions by default and take an `actions` prop so the advance link can reuse them.
 * The adapter wraps a token action so it receives the link's token and access code in the form body,
 * the only place they travel (Section 4.4.6: never in a URL), and tells the page when an answer went
 * in so it can read the packet again.
 */

export type FormAction = (state: FormResult, form: FormData) => Promise<FormResult>;

export interface AdvanceLink {
  readonly token: string;
  readonly accessCode: string;
}

export function withAdvanceLink(
  link: AdvanceLink,
  action: FormAction,
  onDone?: () => void,
): FormAction {
  return async (state, form) => {
    form.set("token", link.token);
    form.set("accessCode", link.accessCode);
    const result = await action(state, form);
    if (result.done) onDone?.();
    return result;
  };
}
