/**
 * In or Out at a gate, remembered per device across restarts (B8, 6250): a phone posted at an exit stays on Out, so it
 * never silently records entries after the app restarts. A device setting of no sensitivity, kept in the same store
 * as the device's other small settings; a store that cannot answer reads as In, the direction the server defaults to.
 */
import type { ScanDirection } from "./scan";

export const GATE_DIRECTION_KEY = "xos.scan.direction";

export interface DirectionStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function loadGateDirection(store: DirectionStore): Promise<ScanDirection> {
  try {
    return (await store.getItem(GATE_DIRECTION_KEY)) === "Out" ? "Out" : "In";
  } catch {
    return "In";
  }
}

export async function saveGateDirection(
  store: DirectionStore,
  direction: ScanDirection,
): Promise<void> {
  try {
    await store.setItem(GATE_DIRECTION_KEY, direction);
  } catch {
    // The toggle still holds for this session; only the memory across a restart is lost.
  }
}
