import { describe, expect, it } from "vitest";
import {
  BADGE_PHOTO_MAX_BYTES,
  badgePhotoExtension,
  badgePhotos,
  countOutcomes,
  credentialPhotoPath,
  fetchProfilePhoto,
  isBadgePhotoBytes,
  loadBadgePhotoBytes,
  myCredentialPhotos,
  recordCredentialPhoto,
  removeCredentialPhotoObjects,
  requestCredentialPhotos,
  withdrawMyCredentialPhotos,
  type BadgePhotoRow,
} from "../src/credential-photos.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const ORG = "0190a000-0000-7000-8000-000000000001";
const PERSON = "0190a000-0000-7000-8000-000000000002";

/** A client whose storage serves the given objects, by bucket:path, and answers public URLs on its own origin. */
function withStorage(
  db: ReturnType<typeof fakeClient>["db"],
  objects: Record<string, Uint8Array>,
  removable: readonly string[] = [],
) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      ...db,
      storage: {
        from: (bucket: string) => ({
          download: async (path: string) => {
            calls.push(`download:${bucket}:${path}`);
            const bytes = objects[`${bucket}:${path}`];
            return bytes
              ? { data: new Blob([bytes.slice()]), error: null }
              : { data: null, error: { message: "Object not found" } };
          },
          getPublicUrl: (path: string) => ({
            data: {
              publicUrl: `https://project.supabase.test/storage/v1/object/public/${bucket}/${path}`,
            },
          }),
          remove: async (paths: string[]) => {
            calls.push(`remove:${bucket}:${paths.join(",")}`);
            return {
              data: paths.filter((p) => removable.includes(p)).map((name) => ({ name })),
              error: null,
            };
          },
        }),
      },
    } as unknown as ReturnType<typeof fakeClient>["db"],
  };
}

const row = (over: Partial<BadgePhotoRow>): BadgePhotoRow => ({
  credentialId: "c1",
  holderPersonId: PERSON,
  state: "Provided",
  bucketId: "credential-photos",
  photoPath: `${ORG}/${PERSON}/a.jpg`,
  requestedAt: null,
  providedAt: "2026-10-30T00:00:00Z",
  source: "Holder Upload",
  ...over,
});

describe("badge photo paths and bytes", () => {
  it("builds the object name in the holder's own folder of the org", () => {
    expect(credentialPhotoPath(ORG, PERSON, "png", "0190a000-0000-7000-8000-000000000003")).toBe(
      `${ORG}/${PERSON}/0190a000-0000-7000-8000-000000000003.png`,
    );
    expect(credentialPhotoPath(ORG, PERSON)).toMatch(
      new RegExp(`^${ORG}/${PERSON}/[0-9a-f-]{36}\\.jpg$`),
    );
  });

  it("embeds only a JPEG or PNG signature of at most 2 MiB", () => {
    expect(isBadgePhotoBytes(JPEG)).toBe(true);
    expect(isBadgePhotoBytes(PNG)).toBe(true);
    expect(isBadgePhotoBytes(WEBP)).toBe(false);
    expect(isBadgePhotoBytes(new Uint8Array())).toBe(false);
    const big = new Uint8Array(BADGE_PHOTO_MAX_BYTES + 1);
    big.set(JPEG);
    expect(isBadgePhotoBytes(big)).toBe(false);
    expect(isBadgePhotoBytes(big.subarray(0, BADGE_PHOTO_MAX_BYTES))).toBe(true);
    expect(BADGE_PHOTO_MAX_BYTES).toBe(2_097_152);
    expect(badgePhotoExtension(PNG)).toBe("png");
    expect(badgePhotoExtension(JPEG)).toBe("jpg");
    expect(badgePhotoExtension(WEBP)).toBeNull();
  });
});

describe("the photo a badge prints", () => {
  it("maps the state rows and keeps a path only where a badge reads from it", async () => {
    const { db, calls } = fakeClient({
      "rpc:credential_badge_photos": [
        okResponse([
          {
            credential_id: "c1",
            holder_person_id: PERSON,
            photo_state: "Profile",
            bucket_id: "profile-media",
            photo_path: `${PERSON}/avatar.jpg`,
            requested_at: null,
            provided_at: null,
            source: null,
          },
          {
            credential_id: "c2",
            holder_person_id: PERSON,
            photo_state: "Refused",
            bucket_id: null,
            photo_path: null,
            requested_at: "2026-10-29T00:00:00Z",
            provided_at: "2026-10-29T01:00:00Z",
            source: "Holder Upload",
          },
        ]),
      ],
    });
    const r = await badgePhotos(db, ["c1", "c2"]);
    expect(r.ok && r.data.map((x) => [x.state, x.bucketId, x.photoPath])).toEqual([
      ["Profile", "profile-media", `${PERSON}/avatar.jpg`],
      ["Refused", null, null],
    ]);
    expect(calls[0]?.steps).toEqual([["args", [{ p_credential_ids: ["c1", "c2"] }]]]);
    expect(await badgePhotos(db, [])).toEqual({ ok: true, data: [] });
  });

  it("reads a badge photo as the caller and a profile photo from its public URL, and drops what it cannot embed", async () => {
    const base = fakeClient({});
    const { db, calls } = withStorage(base.db, {
      [`credential-photos:${ORG}/${PERSON}/a.jpg`]: JPEG,
      [`credential-photos:${ORG}/${PERSON}/b.jpg`]: WEBP,
    });
    const fetched: string[] = [];
    const fetcher = (async (url: string) => {
      fetched.push(url);
      return new Response(PNG.slice(), { status: 200 });
    }) as unknown as typeof fetch;
    const photos = await loadBadgePhotoBytes(
      db,
      [
        row({ credentialId: "c1" }),
        row({ credentialId: "c2", photoPath: `${ORG}/${PERSON}/b.jpg` }),
        row({ credentialId: "c3", bucketId: "profile-media", photoPath: `${PERSON}/avatar.png` }),
        row({ credentialId: "c4", state: "Missing", bucketId: null, photoPath: null }),
        row({ credentialId: "c5", photoPath: `${ORG}/${PERSON}/gone.jpg` }),
      ],
      fetcher,
    );
    expect([...photos.keys()].sort()).toEqual(["c1", "c3"]);
    expect(photos.get("c1")).toEqual({ bytes: JPEG, source: "Badge" });
    expect(photos.get("c3")).toEqual({ bytes: PNG, source: "Profile" });
    // profile-media is public with no select policy (0860): its bytes never come through a signed-in download.
    expect(calls.some((c) => c.startsWith("download:profile-media"))).toBe(false);
    expect(fetched).toEqual([
      `https://project.supabase.test/storage/v1/object/public/profile-media/${PERSON}/avatar.png`,
    ]);
  });

  it("refuses a profile photo over 2 MiB or of another type, and a failed fetch", async () => {
    const { db } = withStorage(fakeClient({}).db, {});
    const answer = (body: Uint8Array, headers: Record<string, string> = {}, status = 200) =>
      (async () => new Response(body.slice(), { status, headers })) as unknown as typeof fetch;
    expect(await fetchProfilePhoto(db, "p/a.jpg", answer(JPEG))).toEqual(JPEG);
    expect(await fetchProfilePhoto(db, "p/a.webp", answer(WEBP))).toBeNull();
    expect(
      await fetchProfilePhoto(
        db,
        "p/a.jpg",
        answer(JPEG, { "content-length": String(BADGE_PHOTO_MAX_BYTES + 1) }),
      ),
    ).toBeNull();
    const big = new Uint8Array(BADGE_PHOTO_MAX_BYTES + 10);
    big.set(JPEG);
    expect(await fetchProfilePhoto(db, "p/a.jpg", answer(big))).toBeNull();
    expect(await fetchProfilePhoto(db, "p/a.jpg", answer(JPEG, {}, 404))).toBeNull();
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchProfilePhoto(db, "p/a.jpg", broken)).toBeNull();
  });
});

describe("asking for, giving and withdrawing photos", () => {
  it("passes the ids and returns one outcome per credential, counted by outcome", async () => {
    const { db } = fakeClient({
      "rpc:request_credential_photos": [
        okResponse([
          { credential_id: "c1", outcome: "requested" },
          { credential_id: "c2", outcome: "requested" },
          { credential_id: "c3", outcome: "no_sign_in" },
        ]),
      ],
    });
    const r = await requestCredentialPhotos(db, ["c1", "c2", "c3"]);
    expect(r.ok && countOutcomes(r.data)).toEqual({ requested: 2, no_sign_in: 1 });
  });

  it("returns the refusal rule of a batch that is too large", async () => {
    const { db } = fakeClient({
      "rpc:request_credential_photos": [
        errorResponse(
          "XR001",
          "credential_photo_batch_size: Ask for the photos of 1 to 100 credentials at a time.",
          "credential_photo_batch_size",
        ),
      ],
    });
    expect(await requestCredentialPhotos(db, [])).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "credential_photo_batch_size" },
    });
  });

  it("records a photo with the notice version and returns the one it replaced", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_credential_photo": [
        okResponse([{ credential_photo_id: "cp1", replaced_path: `${ORG}/${PERSON}/old.jpg` }]),
      ],
    });
    const r = await recordCredentialPhoto(db, {
      orgId: ORG,
      photoPath: `${ORG}/${PERSON}/new.jpg`,
      source: "Holder Profile Photo",
    });
    expect(r).toEqual({ ok: true, data: { id: "cp1", replacedPath: `${ORG}/${PERSON}/old.jpg` } });
    expect(calls[0]?.steps).toEqual([
      [
        "args",
        [
          {
            p_org_id: ORG,
            p_photo_path: `${ORG}/${PERSON}/new.jpg`,
            p_source: "Holder Profile Photo",
            p_notice_version: "credential-photo-2026-11",
          },
        ],
      ],
    ]);
  });

  it("withdraws in one org or all, and lists the holder's cards", async () => {
    const { db, calls } = fakeClient({
      "rpc:withdraw_my_credential_photos": [
        okResponse([{ org_id: ORG, photo_path: `${ORG}/${PERSON}/a.jpg` }]),
        okResponse([]),
      ],
      "rpc:my_credential_photos": [
        okResponse([
          {
            org_id: ORG,
            org_name: "Northwind Live",
            photo_state: "Scanning",
            source: "Holder Upload",
            provided_at: "2026-10-30T00:00:00Z",
            photo_path: `${ORG}/${PERSON}/a.jpg`,
            has_profile_photo: true,
          },
        ]),
      ],
    });
    expect(await withdrawMyCredentialPhotos(db, ORG)).toEqual({
      ok: true,
      data: [{ orgId: ORG, photoPath: `${ORG}/${PERSON}/a.jpg` }],
    });
    await withdrawMyCredentialPhotos(db, null);
    expect(calls.map((c) => c.steps[0]?.[1])).toEqual([[{ p_org_id: ORG }], [{}]]);
    const mine = await myCredentialPhotos(db);
    expect(mine.ok && mine.data[0]).toMatchObject({
      orgName: "Northwind Live",
      state: "Scanning",
      hasProfilePhoto: true,
    });
  });

  it("fails when storage leaves a badge photo object behind", async () => {
    const paths = [`${ORG}/${PERSON}/a.jpg`, `${ORG}/${PERSON}/b.jpg`];
    const all = withStorage(fakeClient({}).db, {}, paths);
    expect(await removeCredentialPhotoObjects(all.db, [...paths, paths[0] as string])).toEqual({
      ok: true,
      data: 2,
    });
    const some = withStorage(fakeClient({}).db, {}, [paths[0] as string]);
    expect(await removeCredentialPhotoObjects(some.db, paths)).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "1 badge photo object(s) could not be removed." },
    });
    expect(await removeCredentialPhotoObjects(some.db, [])).toEqual({ ok: true, data: 0 });
  });
});
