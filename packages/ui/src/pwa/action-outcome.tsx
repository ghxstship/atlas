"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Runs a callback when a form's server action succeeded, for funnel signals (A146, ADR 0052) and the like, while the
 * form keeps the server action itself in useActionState, so it still posts without JavaScript (ADR 0001).
 *
 * A form that stays on the page sees its result in an effect. A form whose row leaves the page with the result (an
 * answer that leaves the review queue once reviewed) never commits that result, so it cannot: the revalidated page
 * drops it in the same commit. Wrap such rows in an ActionOutcomeScope, which stays mounted. A form that left while
 * its action was pending counts as succeeded when the scope's `token`, the page's account of what those forms change,
 * changed in the same commit; a refused action leaves the row and the token as they were.
 */

interface Waiting {
  readonly succeeded: () => void;
  left: boolean;
}

const OutcomeScope = createContext<Map<object, Waiting> | null>(null);

export function ActionOutcomeScope({ token, children }: { token: string; children: ReactNode }) {
  const [waiting] = useState(() => new Map<object, Waiting>());
  const last = useRef(token);
  useEffect(() => {
    if (last.current === token) return;
    last.current = token;
    for (const [form, entry] of waiting) {
      if (!entry.left) continue;
      waiting.delete(form);
      entry.succeeded();
    }
  }, [token, waiting]);
  return <OutcomeScope value={waiting}>{children}</OutcomeScope>;
}

/**
 * Calls `onSuccess` once for each result of the form's action that `succeeded` accepts, `state` and `pending` being
 * what useActionState returned. Inside an ActionOutcomeScope it also covers a form that leaves with its result.
 */
export function useActionOutcome<S>(
  state: S,
  pending: boolean,
  succeeded: (state: S) => boolean,
  onSuccess: (() => void) | undefined,
): void {
  const scope = useContext(OutcomeScope);
  const [form] = useState(() => ({}));
  const seen = useRef(state);
  const latest = useRef({ succeeded, onSuccess });
  useLayoutEffect(() => {
    latest.current = { succeeded, onSuccess };
  });
  useEffect(() => {
    if (!pending || !scope) return;
    scope.set(form, { succeeded: () => latest.current.onSuccess?.(), left: false });
  }, [pending, scope, form]);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    scope?.delete(form);
    if (latest.current.succeeded(state)) latest.current.onSuccess?.();
  }, [state, scope, form]);
  useEffect(() => {
    const entry = scope?.get(form);
    if (entry) entry.left = false;
    return () => {
      const waiting = scope?.get(form);
      if (waiting) waiting.left = true;
    };
  }, [scope, form]);
}
