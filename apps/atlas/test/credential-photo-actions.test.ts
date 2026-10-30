import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The operator's badge photo actions (P5, G-144) against a recording client: the print panel's "Request missing
 * photos" asks only the checked badges whose photo is Missing or Requested and returns with a count per outcome
 * (acceptance 12), and "Remove photo" deletes what the database hands back, so a photo whose object the scanner
 * already deleted is removed cleanly, and one still being scanned is refused by rule with nothing deleted.
 */

const ORG = "0190a000-0000-7000-8000-000000000001";
const PERSON = "0190a000-0000-7000-8000-000000000002";
const ids = Array.from(
  { length: 6 },
  (_, i) => `0190a000-0000-7000-8000-0000000001${String(i).padStart(2, "0")}`,
);

type Answer = { data: unknown; error: { code?: string; message: string; hint?: string } | null };

const state = vi.hoisted(() => ({
  rpc: [] as { name: string; args: unknown }[],
  rpcAnswers: {} as Record<string, Answer[]>,
  states: [] as { credential_id: string; photo_state: string }[],
  read: [] as unknown[],
  removed: [] as string[][],
  /** The names storage reports as deleted; anything else it silently keeps, as Supabase does. */
  deletable: new Set<string>(),
  redirects: [] as string[],
}));

const db = {
  rpc: async (name: string, args: unknown) => {
    state.rpc.push({ name, args });
    const next = state.rpcAnswers[name]?.shift();
    if (!next) throw new Error(`no answer queued for ${name}`);
    return next;
  },
  from: (table: string) => ({
    select: () => ({
      in: async (_column: string, values: unknown[]) => {
        if (table !== "credential_photo_states") throw new Error(`unexpected read of ${table}`);
        state.read.push(values);
        return {
          data: state.states.filter((s) => values.includes(s.credential_id)),
          error: null,
        };
      },
    }),
  }),
  storage: {
    from: (bucket: string) => ({
      remove: async (paths: string[]) => {
        if (bucket !== "credential-photos") throw new Error(`unexpected bucket ${bucket}`);
        state.removed.push(paths);
        return {
          data: paths.filter((p) => state.deletable.has(p)).map((name) => ({ name })),
          error: null,
        };
      },
    }),
  },
};

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    state.redirects.push(to);
    throw new Error("redirect");
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: ORG, slug: "acme" }, viewer: { db } }),
}));
vi.mock("@/lib/shell/translate", () => ({
  getTranslate: async () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
}));

const { removeCredentialPhotoAction, requestMissingPhotosAction } =
  await import("@/lib/credentials/actions");
const { formatAsked, parseAsked } = await import("@/lib/credentials/photo-outcomes");

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) f.append(name, v);
  }
  return f;
}

async function requestMissing(fields: Record<string, string | string[]>): Promise<URL> {
  await expect(requestMissingPhotosAction(form({ org: "acme", ...fields }))).rejects.toThrow(
    "redirect",
  );
  return new URL(state.redirects.at(-1) ?? "", "http://x");
}

beforeEach(() => {
  state.rpc = [];
  state.rpcAnswers = {};
  state.states = [];
  state.read = [];
  state.removed = [];
  state.deletable = new Set();
  state.redirects = [];
});

describe("Request missing photos (acceptance 12)", () => {
  it("asks only the checked badges whose photo is Missing or Requested, and returns with the counts", async () => {
    const [missing, requested, provided, scanning, profile, refused] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    state.states = [
      { credential_id: missing, photo_state: "Missing" },
      { credential_id: requested, photo_state: "Requested" },
      { credential_id: provided, photo_state: "Provided" },
      { credential_id: scanning, photo_state: "Scanning" },
      { credential_id: profile, photo_state: "Profile" },
      { credential_id: refused, photo_state: "Refused" },
    ];
    state.rpcAnswers["request_credential_photos"] = [
      {
        data: [
          { credential_id: missing, outcome: "requested" },
          { credential_id: requested, outcome: "no_sign_in" },
        ],
        error: null,
      },
    ];
    const to = await requestMissing({
      id: [missing, requested, provided, scanning, profile, refused],
      back: "/acme/credentials/issued?project=NWS",
    });
    expect(state.read).toEqual([[missing, requested, provided, scanning, profile, refused]]);
    expect(state.rpc).toEqual([
      { name: "request_credential_photos", args: { p_credential_ids: [missing, requested] } },
    ]);
    expect(to.pathname).toBe("/acme/credentials/issued");
    expect(to.searchParams.get("project")).toBe("NWS");
    expect(to.searchParams.get("print")).toBe("1");
    expect(to.searchParams.get("asked")).toBe("requested:1,no_sign_in:1");
  });

  it("asks nobody when no checked badge needs a photo, and says so", async () => {
    const [provided] = ids as [string];
    state.states = [{ credential_id: provided, photo_state: "Provided" }];
    const to = await requestMissing({ id: [provided], back: "/acme/credentials/issued" });
    expect(state.rpc).toEqual([]);
    expect(to.searchParams.get("asked")).toBe("none");
  });

  it("returns to the panel without asking when the ids are missing or malformed, and never leaves the app", async () => {
    let to = await requestMissing({ back: "//elsewhere.test/x" });
    expect(to.origin).toBe("http://x");
    expect(to.pathname).toBe("/acme/credentials/issued");
    expect(to.searchParams.get("asked")).toBeNull();
    to = await requestMissing({ id: ["not-a-uuid"], back: "/acme/credentials/issued" });
    expect(to.searchParams.get("asked")).toBeNull();
    to = await requestMissing({ id: Array.from({ length: 101 }, () => ids[0] as string) });
    expect(to.searchParams.get("asked")).toBeNull();
    expect(state.read).toEqual([]);
    expect(state.rpc).toEqual([]);
  });
});

describe("the asked parameter", () => {
  it("round-trips counts and ignores anything unexpected", () => {
    expect(parseAsked(formatAsked({ requested: 3, recently_requested: 1 }))).toEqual({
      requested: 3,
      recently_requested: 1,
    });
    expect(formatAsked({})).toBe("none");
    expect(parseAsked("none")).toEqual({});
    expect(parseAsked(undefined)).toEqual({});
    expect(
      parseAsked(
        "requested:2,bogus:4,no_sign_in:x,not_allowed:1000,already_provided:-1,not_notified:7",
      ),
    ).toEqual({ requested: 2, not_notified: 7 });
  });
});

describe("Remove photo", () => {
  const path = (name: string) => `${ORG}/${PERSON}/${name}`;
  const remove = (fields: Record<string, string> = {}) =>
    removeCredentialPhotoAction(
      {},
      form({ org: "acme", personId: PERSON, confirm: "on", ...fields }),
    );

  it("needs the confirmation and a person", async () => {
    expect(await remove({ confirm: "" })).toEqual({ error: "confirmRemovePhoto" });
    expect(await remove({ personId: "x" })).toEqual({ error: "notFound" });
    expect(state.rpc).toEqual([]);
  });

  it("deletes the Clean objects the database returns", async () => {
    state.rpcAnswers["remove_credential_photo"] = [
      { data: [path("a.jpg"), path("b.png")], error: null },
    ];
    state.deletable = new Set([path("a.jpg"), path("b.png")]);
    expect(await remove()).toEqual({ ok: true });
    expect(state.rpc).toEqual([
      { name: "remove_credential_photo", args: { p_org_id: ORG, p_person_id: PERSON } },
    ]);
    expect(state.removed).toEqual([[path("a.jpg"), path("b.png")]]);
  });

  it("succeeds with nothing to delete when the scanner already deleted a Refused photo's object", async () => {
    state.rpcAnswers["remove_credential_photo"] = [{ data: [], error: null }];
    expect(await remove()).toEqual({ ok: true });
    expect(state.removed).toEqual([]);
  });

  it("is refused by rule while the photo is being scanned, or when its scan could not clear it", async () => {
    for (const rule of ["credential_photo_scanning", "credential_photo_unscanned"]) {
      state.rpcAnswers["remove_credential_photo"] = [
        { data: null, error: { code: "XR001", message: `${rule}: refused`, hint: rule } },
      ];
      expect(await remove()).toEqual({ error: `rules.${rule}` });
    }
    expect(state.removed).toEqual([]);
  });

  it("is refused by rule for someone who does not issue the holder's credentials", async () => {
    state.rpcAnswers["remove_credential_photo"] = [
      {
        data: null,
        error: {
          code: "XR001",
          message: "credential_photo_not_issuer: refused",
          hint: "credential_photo_not_issuer",
        },
      },
    ];
    expect(await remove()).toEqual({ error: "rules.credential_photo_not_issuer" });
  });

  it("reports an object storage kept instead of claiming success", async () => {
    state.rpcAnswers["remove_credential_photo"] = [{ data: [path("a.jpg")], error: null }];
    expect(await remove()).toEqual({ error: "unexpected" });
  });
});
