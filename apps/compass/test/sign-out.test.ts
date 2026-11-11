import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signOutThisDevice, THIS_DEVICE } from "../src/runtime/signOut";

const root = new URL("..", import.meta.url).pathname;

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [{ path: join(dir, e.name), text: readFileSync(join(dir, e.name), "utf8") }]
        : [],
  );
}

describe("Sign Out (C-05)", () => {
  it("ends only this device's session, after wiping what the device holds", async () => {
    const calls: string[] = [];
    const scopes: unknown[] = [];
    await signOutThisDevice({
      auth: {
        signOut: async (options) => {
          calls.push("auth");
          scopes.push(options);
          return { error: null };
        },
      },
      syncSession: {
        remoteSignOut: async () => {
          calls.push("sync");
          return 0;
        },
      },
      store: {
        wipe: async () => {
          calls.push("store");
        },
      },
    });
    expect(scopes).toEqual([{ scope: "local" }]);
    expect(THIS_DEVICE).toEqual({ scope: "local" });
    // The sync session wipes the store itself; the store is wiped directly only without one.
    expect(calls).toEqual(["sync", "auth"]);
  });

  it("wipes the store when no sync session is running", async () => {
    const calls: string[] = [];
    await signOutThisDevice({
      auth: {
        signOut: async () => {
          calls.push("auth");
        },
      },
      syncSession: null,
      store: {
        wipe: async () => {
          calls.push("store");
        },
      },
    });
    expect(calls).toEqual(["store", "auth"]);
  });

  it("names the scope at every sign-out in Compass, so none falls back to the global default", () => {
    const bare = [...sources(join(root, "src")), ...sources(join(root, "app"))].flatMap((f) =>
      f.text.includes("auth.signOut()") ? [f.path.slice(root.length)] : [],
    );
    expect(bare).toEqual([]);
  });
});
