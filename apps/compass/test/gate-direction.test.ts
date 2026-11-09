import { describe, expect, it } from "vitest";
import {
  GATE_DIRECTION_KEY,
  loadGateDirection,
  saveGateDirection,
  type DirectionStore,
} from "../src/domain/gate-direction";

function memory(): DirectionStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

const broken: DirectionStore = {
  getItem: async () => {
    throw new Error("no store");
  },
  setItem: async () => {
    throw new Error("no store");
  },
};

describe("the gate's direction on this device (B8)", () => {
  it("starts on In", async () => {
    expect(await loadGateDirection(memory())).toBe("In");
  });

  it("is still Out after a restart, which reads the store again", async () => {
    const store = memory();
    await saveGateDirection(store, "Out");
    expect(store.values.get(GATE_DIRECTION_KEY)).toBe("Out");
    expect(await loadGateDirection(store)).toBe("Out");
    await saveGateDirection(store, "In");
    expect(await loadGateDirection(store)).toBe("In");
  });

  it("reads anything else, or a store that cannot answer, as In", async () => {
    const store = memory();
    store.values.set(GATE_DIRECTION_KEY, "Sideways");
    expect(await loadGateDirection(store)).toBe("In");
    expect(await loadGateDirection(broken)).toBe("In");
    await expect(saveGateDirection(broken, "Out")).resolves.toBeUndefined();
  });
});
