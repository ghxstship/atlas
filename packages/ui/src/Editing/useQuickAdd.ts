import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../lib/context.tsx";
import { parseQuickAdd } from "./parseQuickAdd.tsx";
import {
  finalizeQuickAdd,
  quickAddKey,
  type QuickAddParse,
  type QuickAddResolution,
  type QuickAddResolver,
  type QuickAddResult,
  type QuickAddToken,
} from "./quickAddCore.ts";

export interface UseQuickAddOptions {
  /** The line as typed; the caller owns the input. */
  text: string;
  referenceDate?: Date;
  /** The language of date phrases; the provider's locale by default. */
  locale?: string;
  /** The IANA zone date phrases are read in; the device's by default. */
  timeZone?: string;
  /** Resolves people, tags, kinds and scopes; without one, every token applies as typed. */
  resolve?: QuickAddResolver;
  /** How long typing pauses before tokens are resolved, in milliseconds. */
  delay?: number;
}

export interface QuickAddController {
  parse: QuickAddParse;
  /** Resolutions by token key, or undefined when there is no resolver. */
  resolutions: Readonly<Record<string, QuickAddResolution>> | undefined;
  /** True while a token of the line waits for its resolution. */
  pending: boolean;
  /** Candidates the person chose for ambiguous tokens, by token key. */
  choices: Readonly<Record<string, string>>;
  /** Turns a token back into text. */
  dismiss: (token: QuickAddToken) => void;
  /** Picks one candidate of an ambiguous token. */
  choose: (token: QuickAddToken, id: string) => void;
  /** The line to save: waits for any resolution still out, then folds unresolved tokens back. */
  finalize: () => Promise<QuickAddResult>;
  /** Forgets dismissed tokens and choices, after a save. */
  reset: () => void;
}

const resolvable = (t: QuickAddToken) => t.type !== "date";

/**
 * Quick add state for any input (Section 11.7): the parse of the current line in the person's
 * language and the org's zone, resolutions fetched once per token after typing pauses, dismissed
 * tokens and chosen candidates. `QuickAdd` uses it with its own input; the Atlas Create menu uses it
 * with the command menu's.
 */
export function useQuickAdd({
  text,
  referenceDate,
  locale,
  timeZone,
  resolve,
  delay = 250,
}: UseQuickAddOptions): QuickAddController {
  const contextLocale = useLocale();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const [cache, setCache] = useState<Readonly<Record<string, QuickAddResolution>>>({});
  const cacheRef = useRef(cache);
  const inFlight = useRef(new Map<string, Promise<void>>());
  const resolveRef = useRef(resolve);
  useEffect(() => {
    resolveRef.current = resolve;
  }, [resolve]);

  const parse = useMemo(
    () =>
      parseQuickAdd(text, {
        locale: locale ?? contextLocale,
        dismissed,
        ...(referenceDate ? { referenceDate } : {}),
        ...(timeZone ? { timeZone } : {}),
      }),
    [text, locale, contextLocale, dismissed, referenceDate, timeZone],
  );

  /** Resolves the tokens with no answer yet; tokens already asked about wait for that answer. */
  const fetchMissing = useCallback((tokens: readonly QuickAddToken[]): Promise<void> => {
    const fn = resolveRef.current;
    if (fn === undefined) return Promise.resolve();
    const waiting: Promise<void>[] = [];
    const ask: QuickAddToken[] = [];
    for (const token of tokens) {
      const key = quickAddKey(token);
      if (key in cacheRef.current) continue;
      const flying = inFlight.current.get(key);
      if (flying) waiting.push(flying);
      else if (!ask.some((t) => quickAddKey(t) === key)) ask.push(token);
    }
    if (ask.length > 0) {
      const request = fn(ask)
        .catch(() => ({}) as Readonly<Record<string, QuickAddResolution>>)
        .then((answer) => {
          const next = { ...cacheRef.current };
          for (const token of ask) {
            const key = quickAddKey(token);
            next[key] = answer[key] ?? { status: "unresolved" };
            inFlight.current.delete(key);
          }
          cacheRef.current = next;
          setCache(next);
        });
      for (const token of ask) inFlight.current.set(quickAddKey(token), request);
      waiting.push(request);
    }
    return Promise.all(waiting).then(() => undefined);
  }, []);

  const wanted = parse.tokens.filter(resolvable);
  const wantedKeys = wanted.map(quickAddKey).join("\u0000");
  useEffect(() => {
    if (resolveRef.current === undefined || wantedKeys === "") return undefined;
    const timer = setTimeout(() => void fetchMissing(wanted), delay);
    return () => clearTimeout(timer);
    // `wanted` changes with its keys: it is derived from the same parse.
  }, [wantedKeys, delay, fetchMissing]);

  const resolutions = resolve === undefined ? undefined : cache;
  const pending = resolve !== undefined && wanted.some((t) => !(quickAddKey(t) in cache));

  const finalize = useCallback(async (): Promise<QuickAddResult> => {
    await fetchMissing(parse.tokens.filter(resolvable));
    return finalizeQuickAdd(
      parse,
      resolveRef.current === undefined ? undefined : cacheRef.current,
      choices,
    );
  }, [fetchMissing, parse, choices]);

  return {
    parse,
    resolutions,
    pending,
    choices,
    dismiss: useCallback(
      (token: QuickAddToken) => setDismissed((d) => [...d, quickAddKey(token)]),
      [],
    ),
    choose: useCallback(
      (token: QuickAddToken, id: string) => setChoices((c) => ({ ...c, [quickAddKey(token)]: id })),
      [],
    ),
    finalize,
    reset: useCallback(() => {
      setDismissed([]);
      setChoices({});
    }, []),
  };
}
