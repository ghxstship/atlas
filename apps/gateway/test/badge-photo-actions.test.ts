import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gateway's "Use my profile photo" and "Remove" (P5, G-144, acceptance 13) against a recording client: the profile
 * photo's bytes come from its public URL, are checked again for the JPEG or PNG signature and the 2 MiB cap, and are
 * stored in the holder's own folder and recorded with source Holder Profile Photo. Anything else stores nothing.
 * Remove withdraws the photo and consent and deletes every object the database hands back.
 */

const ORG = "0190a000-0000-7000-8000-000000000001";
const PERSON = "0190a000-0000-7000-8000-000000000002";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");

const state = vi.hoisted(() => ({
  profilePath: null as string | null,
  fetched: [] as string[],
  body: new Uint8Array() as Uint8Array,
  uploads: [] as { bucket: string; path: string; type: string | undefined; size: number }[],
  removed: [] as string[][],
  rpc: [] as { name: string; args: unknown }[],
  withdrawn: [] as { org_id: string; photo_path: string }[],
}));

const db = {
  from: (table: string) => {
    if (table !== "person_profiles") throw new Error(`unexpected read of ${table}`);
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      maybeSingle: async () => ({
        data: state.profilePath ? { photo_path: state.profilePath } : null,
        error: null,
      }),
    };
    return chain;
  },
  rpc: async (name: string, args: unknown) => {
    state.rpc.push({ name, args });
    if (name === "record_credential_photo") {
      return { data: [{ credential_photo_id: "photo-1", replaced_path: null }], error: null };
    }
    if (name === "withdraw_my_credential_photos") return { data: state.withdrawn, error: null };
    throw new Error(`unexpected rpc ${name}`);
  },
  storage: {
    from: (bucket: string) => ({
      getPublicUrl: (path: string) => ({
        data: {
          publicUrl: `https://project.supabase.test/storage/v1/object/public/${bucket}/${path}`,
        },
      }),
      upload: async (path: string, bytes: Uint8Array, options?: { contentType?: string }) => {
        state.uploads.push({ bucket, path, type: options?.contentType, size: bytes.length });
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        state.removed.push(paths);
        return { data: paths.map((name) => ({ name })), error: null };
      },
    }),
  },
};

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({
  getGatewayContext: async () => ({ db, personId: PERSON }),
}));

const { chooseProfilePhotoAction, removeBadgePhotoAction } = await import("@/lib/actions/profile");

beforeEach(() => {
  state.profilePath = `${PERSON}/avatar.png`;
  state.fetched = [];
  state.body = PNG;
  state.uploads = [];
  state.removed = [];
  state.rpc = [];
  state.withdrawn = [];
  vi.stubGlobal("fetch", async (url: string) => {
    state.fetched.push(url);
    return new Response(state.body.slice(), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Use my profile photo", () => {
  it("copies the profile photo into the holder's folder and records it as Holder Profile Photo", async () => {
    expect(await chooseProfilePhotoAction(ORG)).toEqual({ ok: true });
    expect(state.fetched).toEqual([
      `https://project.supabase.test/storage/v1/object/public/profile-media/${PERSON}/avatar.png`,
    ]);
    expect(state.uploads).toHaveLength(1);
    const [upload] = state.uploads;
    expect(upload).toMatchObject({
      bucket: "credential-photos",
      type: "image/png",
      size: PNG.length,
    });
    expect(upload?.path).toMatch(new RegExp(`^${ORG}/${PERSON}/[0-9a-f-]{36}\\.png$`));
    expect(state.rpc).toEqual([
      {
        name: "record_credential_photo",
        args: {
          p_org_id: ORG,
          p_photo_path: upload?.path,
          p_source: "Holder Profile Photo",
          p_notice_version: "credential-photo-2026-11",
        },
      },
    ]);
  });

  it("stores nothing for a WebP, a photo over 2 MiB, no profile photo or a bad org id", async () => {
    state.body = WEBP;
    expect(await chooseProfilePhotoAction(ORG)).toEqual({ ok: false, outcome: "invalid" });
    const big = new Uint8Array(2_097_153);
    big.set(PNG);
    state.body = big;
    expect(await chooseProfilePhotoAction(ORG)).toEqual({ ok: false, outcome: "invalid" });
    state.body = PNG;
    state.profilePath = null;
    expect(await chooseProfilePhotoAction(ORG)).toEqual({ ok: false, outcome: "invalid" });
    expect(await chooseProfilePhotoAction("not-an-org")).toEqual({ ok: false, outcome: "invalid" });
    expect(state.uploads).toEqual([]);
    expect(state.rpc).toEqual([]);
  });
});

describe("Remove", () => {
  it("withdraws the photo and consent for the org and deletes every object returned", async () => {
    state.withdrawn = [
      { org_id: ORG, photo_path: `${ORG}/${PERSON}/a.jpg` },
      { org_id: ORG, photo_path: `${ORG}/${PERSON}/b.png` },
    ];
    expect(await removeBadgePhotoAction(ORG)).toEqual({ ok: true });
    expect(state.rpc).toEqual([{ name: "withdraw_my_credential_photos", args: { p_org_id: ORG } }]);
    expect(state.removed).toEqual([[`${ORG}/${PERSON}/a.jpg`, `${ORG}/${PERSON}/b.png`]]);
  });
});
