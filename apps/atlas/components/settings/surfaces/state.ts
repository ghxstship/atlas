/**
 * What an A86 settings action returns to its form (RRR-131): success, or a refusal already in words, per-field
 * problems in words, and for keys, tokens and webhook endpoints the secret to show once. `at` changes on every
 * answer, so a form can tell two equal answers apart.
 */
export interface SurfaceState {
  readonly ok?: boolean;
  readonly message?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly secret?: string;
  /** The action needs a recent second factor first (A77): the form opens the step-up dialog and retries. */
  readonly stepUp?: boolean;
  readonly at?: number;
}
