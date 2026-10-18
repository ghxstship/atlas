"use client";

import { useNamespaceT } from "./kit-use-namespace-t";
import { type Translate } from "./kit.types";

export function useFinanceT(): Translate {
  return useNamespaceT("finance");
}
