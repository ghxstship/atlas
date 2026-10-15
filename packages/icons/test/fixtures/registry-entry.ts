/* Bundle fixture: a consumer that draws icons by name through the registry. */
import { resolveIcon } from "../../src/index.ts";

export function pick(name: string): unknown {
  return resolveIcon(name);
}
