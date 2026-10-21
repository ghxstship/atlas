import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mutation } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { SupabaseUploader } from "../src/data/uploader";
import {
  afterServer,
  buildKioskPunch,
  kioskPhotoPath,
  refusalFromServer,
  storedPhotoUri,
  type KioskStep,
} from "../src/domain/kiosk";
import {
  claimRuleOf,
  formatDistance,
  hapticsOn,
  kioskRules,
  NO_VALUES,
  requiresGeofence,
  soundsOn,
  themeOptionsOf,
  valuesFromRows,
  withQueuedSetting,
} from "../src/domain/settings";
import { buildShiftAction, type ShiftRow } from "../src/domain/shifts";

/**
 * The registered settings Compass applies (A65-001): each is changed here and its effect on what the
 * device offers observed. The server enforces the org rules again (migrations 1321, 1322, 1328).
 */

const values = (entries: Record<string, unknown>) => new Map(Object.entries(entries));

describe("resolved settings", () => {
  it("reads app.resolve_settings rows by key", () => {
    const read = valuesFromRows([
      { setting_key: "me.haptics", value_text: null, value_boolean: false, value_integer: null },
      {
        setting_key: "locale.units",
        value_text: "metric",
        value_boolean: null,
        value_integer: null,
      },
      { setting_key: "x.count", value_text: null, value_boolean: null, value_integer: 3 },
    ]);
    expect(read.get("me.haptics")).toBe(false);
    expect(read.get("locale.units")).toBe("metric");
    expect(read.get("x.count")).toBe(3);
  });
});

describe("personal accessibility", () => {
  it("scales text, raises contrast and reduces motion (me.text_size, me.high_contrast, me.reduced_motion)", () => {
    expect(themeOptionsOf(NO_VALUES)).toEqual({
      textScale: 1,
      highContrast: false,
      reduceMotion: false,
    });
    expect(
      themeOptionsOf(
        values({
          "me.text_size": "larger",
          "me.high_contrast": true,
          "me.reduced_motion": "reduce",
        }),
      ),
    ).toEqual({ textScale: 1.3, highContrast: true, reduceMotion: true });
    expect(themeOptionsOf(values({ "me.text_size": "large" })).textScale).toBe(1.15);
  });

  it("plays haptics only while me.haptics is on, falling back to the device switch", () => {
    expect(hapticsOn(true, values({ "me.haptics": false }))).toBe(false);
    expect(hapticsOn(false, values({ "me.haptics": true }))).toBe(true);
    expect(hapticsOn(true, NO_VALUES)).toBe(true);
  });

  it("keeps the Haptics switch where the person put it while the change is queued", () => {
    // The last resolve said on; the person turns Haptics off and the change waits in the outbox.
    const resolved = values({ "me.haptics": true });
    const off = {
      op: "rpc",
      target: "set_personal_setting",
      payload: { p_setting_key: "me.haptics", p_value_boolean: false },
    };
    expect(hapticsOn(false, withQueuedSetting(resolved, off))).toBe(false);
    expect(hapticsOn(false, resolved)).toBe(true);
    // Other mutations and keys Compass does not read leave the values as they are.
    const theme = { ...off, payload: { p_setting_key: "me.theme", p_value_text: "light" } };
    expect(withQueuedSetting(resolved, theme)).toBe(resolved);
    expect(withQueuedSetting(resolved, { op: "update", payload: {} })).toBe(resolved);
  });

  it("silences the camera shutter while me.sounds is off", () => {
    expect(soundsOn(values({ "me.sounds": false }))).toBe(false);
    expect(soundsOn(NO_VALUES)).toBe(true);
  });

  it("shows distances in the person's units (locale.units)", () => {
    expect(formatDistance("en-US", 120, NO_VALUES)).toBe("394 ft");
    expect(formatDistance("en-US", 120, values({ "locale.units": "metric" }))).toBe("120 m");
    expect(formatDistance("en-US", 2500, values({ "locale.units": "metric" }))).toBe("2.5 km");
    expect(formatDistance("en-US", 3218.688, NO_VALUES)).toBe("2 mi");
  });
});

describe("org rules on the device", () => {
  it("asks for the geofence only while time.geofence_required is on and the project has one", () => {
    expect(requiresGeofence(NO_VALUES, 1)).toBe(true);
    expect(requiresGeofence(values({ "time.geofence_required": false }), 1)).toBe(false);
    expect(requiresGeofence(NO_VALUES, 0)).toBe(false);
  });

  it("reads the kiosk rules (time.kiosk_enabled, time.photo_on_punch)", () => {
    expect(kioskRules(NO_VALUES)).toEqual({ enabled: false, photoOnPunch: false });
    expect(kioskRules(values({ "time.kiosk_enabled": true, "time.photo_on_punch": true }))).toEqual(
      { enabled: true, photoOnPunch: true },
    );
  });

  it("keeps a claimed shift open until a supervisor decides, unless the rule is first-come", () => {
    expect(claimRuleOf(NO_VALUES)).toBe("approval");
    expect(claimRuleOf(values({ "scheduling.open_shift_claiming": "first-come" }))).toBe(
      "first-come",
    );
    expect(claimRuleOf(values({ "scheduling.open_shift_claiming": "seniority" }))).toBe(
      "seniority",
    );
    const open = {
      id: "s1",
      project_id: "p1",
      membership_id: null,
      starts_at: "2027-06-04T12:00:00Z",
      ends_at: "2027-06-04T20:00:00Z",
      shift_state: "Published",
    } as unknown as ShiftRow;
    expect(buildShiftAction(open, "claim", false, "m1", "first-come").optimistic).toMatchObject({
      membership_id: "m1",
      shift_state: "Accepted",
    });
    expect(buildShiftAction(open, "claim", false, "m1", "approval").optimistic).toMatchObject({
      membership_id: null,
      shift_state: "Published",
    });
  });
});

describe("kiosk photo on punch", () => {
  const worker = { membershipId: "m1", displayName: "Erin Castillo", onShift: false };

  it("names the photo under the project's kiosk folder and sends it with the punch", () => {
    const path = kioskPhotoPath("o1", "p1", "k1");
    expect(path).toBe("o1/kiosk-punches/p1/k1.jpg");
    const punch = buildKioskPunch(
      {
        deviceKey: "xkio_key",
        projectId: "p1",
        worker,
        pin: "2468",
        deviceAt: "2027-06-04T12:00:00Z",
        monotonicAt: 1,
        bootId: "b",
        photoUri: null,
        photo: { path, localUri: "file:///erin.jpg" },
      },
      0,
      () => "k1",
    );
    expect(punch.payload).toMatchObject({
      photoUri: storedPhotoUri(path),
      storage_path: path,
      local_uri: "file:///erin.jpg",
    });
  });

  it("names kiosks off and a missing photo as their own refusals", () => {
    expect(refusalFromServer("kiosk_disabled")).toBe("kiosk-disabled");
    expect(refusalFromServer("punch_photo_required")).toBe("photo-required");
    const photo: KioskStep = { kind: "photo", worker, digits: "2468" };
    expect(afterServer(photo, { ok: false, reason: "punch_photo_required" })).toEqual({
      kind: "refused",
      worker,
      reason: "photo-required",
    });
  });

  it("uploads the photo before sending a queued kiosk punch, without device fields", async () => {
    const uploads: string[] = [];
    const bodies: string[] = [];
    const uploader = new SupabaseUploader({
      client: {} as SupabaseClient,
      functionsUrl: "https://x.example.com",
      accessToken: () => Promise.resolve("token"),
      orgId: () => "o1",
      deviceId: "device-1",
      clock: { monotonicNow: () => 0, bootId: () => "b", now: () => 0 } as never,
      uploadFile: (path, uri) => (uploads.push(`${path} ${uri}`), Promise.resolve({ error: null })),
      fetchImpl: (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    const m = {
      id: "mut-1",
      op: "rpc",
      target: "kiosk-punch",
      table: "kiosk_punches",
      rowId: "k1",
      payload: {
        punchId: "k1",
        photoUri: "storage://field-media/o1/kiosk-punches/p1/k1.jpg",
        storage_path: "o1/kiosk-punches/p1/k1.jpg",
        local_uri: "file:///erin.jpg",
      },
      policy: "append",
    } as unknown as Mutation;
    expect((await uploader.upload(m)).kind).toBe("applied");
    expect(uploads).toEqual(["o1/kiosk-punches/p1/k1.jpg file:///erin.jpg"]);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
      punchId: "k1",
      photoUri: "storage://field-media/o1/kiosk-punches/p1/k1.jpg",
    });
  });
});
