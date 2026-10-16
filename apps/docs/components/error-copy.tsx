"use client";

/**
 * Copy for the client-side error and not-found boundaries. The layout resolves it on the server
 * for the page's locale, so the boundaries never ship the message catalogs to the browser.
 */
import { createContext, useContext, type ReactNode } from "react";

export interface BoundaryCopy {
  readonly home: string;
  readonly error: { readonly title: string; readonly sentence: string; readonly action: string };
  readonly notFound: { readonly title: string; readonly sentence: string; readonly action: string };
}

const Context = createContext<BoundaryCopy | null>(null);

export function BoundaryCopyProvider({
  copy,
  children,
}: {
  copy: BoundaryCopy;
  children: ReactNode;
}) {
  return <Context.Provider value={copy}>{children}</Context.Provider>;
}

export function useBoundaryCopy(): BoundaryCopy {
  const copy = useContext(Context);
  if (!copy) throw new Error("BoundaryCopyProvider is missing from the layout.");
  return copy;
}
