/* Bundle fixture: the pre-RRR-70 pattern, a namespace import read by a runtime key. */
import * as lucide from "lucide-react";

export function pick(name: string): unknown {
  return (lucide as unknown as Record<string, unknown>)[name];
}
