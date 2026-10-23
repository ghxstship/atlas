"use client";

import type { AiFeature } from "@xos/data/ai";
import { createContext, useContext, type ReactNode } from "react";

/**
 * The Aurora features the viewer may use now (lib/aurora/features.ts), from the shell to every
 * client entry point (A95). Outside the shell, as in tests and the sign-in pages, nothing is on.
 */
const AiFeaturesContext = createContext<readonly AiFeature[]>([]);

export function AiFeaturesProvider({
  features,
  children,
}: {
  features: readonly AiFeature[];
  children: ReactNode;
}) {
  return <AiFeaturesContext.Provider value={features}>{children}</AiFeaturesContext.Provider>;
}

/** True when the feature's switch is on and the plan includes Aurora. */
export function useAiFeature(feature: AiFeature): boolean {
  return useContext(AiFeaturesContext).includes(feature);
}
