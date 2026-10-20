import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpoConfig } from "expo/config";
import { describe, expect, it } from "vitest";
import { releaseConfigProblems, withStoreBuild } from "../app.config";
import {
  iconProblems,
  ownerValues,
  preflightProblems,
  type PreflightInput,
} from "../scripts/store-preflight";

/** Store release configuration (RRR-113): eas.json, privacy, permissions and the preflight. */
const compassDir = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(compassDir, path), "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const appJson = readJson("app.json") as { expo: ExpoConfig };
const expo = appJson.expo;
const easJson = readJson("eas.json") as {
  cli: Record<string, unknown>;
  build: Record<string, Record<string, unknown>>;
  submit: Record<string, Record<string, Record<string, unknown>>>;
};

/** @expo/eas-json is eas-cli's own eas.json reader; resolve it through eas-cli so the versions match. */
const requireFromEasCli = createRequire(
  realpathSync(join(compassDir, "node_modules/eas-cli/package.json")),
);
const easJsonLib = requireFromEasCli("@expo/eas-json") as {
  EasJsonAccessor: { fromProjectPath(dir: string): unknown; fromRawString(raw: string): unknown };
  EasJsonUtils: {
    getBuildProfileAsync(
      a: unknown,
      platform: string,
      name: string,
    ): Promise<Record<string, unknown>>;
    getSubmitProfileAsync(
      a: unknown,
      platform: string,
      name: string,
    ): Promise<Record<string, unknown>>;
    getCliConfigAsync(a: unknown): Promise<Record<string, unknown>>;
  };
};
const submitSchemas = requireFromEasCli("@expo/eas-json/build/submit/schema") as {
  ResolvedIosSubmitProfileSchema: { validate(v: unknown): { error?: Error } };
};

describe("eas.json", () => {
  const accessor = easJsonLib.EasJsonAccessor.fromProjectPath(compassDir);

  it("reads with eas-cli's own parser and keeps the build number on EAS", async () => {
    const cli = await easJsonLib.EasJsonUtils.getCliConfigAsync(accessor);
    expect(cli).toMatchObject({ appVersionSource: "remote", requireCommit: true });
    const installed = JSON.parse(
      readFileSync(realpathSync(join(compassDir, "node_modules/eas-cli/package.json")), "utf8"),
    ) as { version: string };
    expect(easJson.cli["version"]).toBe(`>= ${installed.version}`);
  });

  it("builds a signed store binary with an incremented build number for production", async () => {
    for (const platform of ["ios", "android"]) {
      const profile = await easJsonLib.EasJsonUtils.getBuildProfileAsync(
        accessor,
        platform,
        "production",
      );
      expect(profile).toMatchObject({
        environment: "production",
        distribution: "store",
        autoIncrement: true,
      });
      expect(profile["withoutCredentials"]).toBeUndefined();
    }
    const android = await easJsonLib.EasJsonUtils.getBuildProfileAsync(
      accessor,
      "android",
      "production",
    );
    expect(android["buildType"]).toBe("app-bundle");
  });

  it("gives every profile its own EAS environment and commits no secret", async () => {
    for (const name of ["development", "preview", "production"]) {
      const profile = await easJsonLib.EasJsonUtils.getBuildProfileAsync(accessor, "ios", name);
      expect(profile["environment"]).toBe(name);
      const env = (profile["env"] ?? {}) as Record<string, string>;
      for (const key of Object.keys(env)) {
        expect(key).not.toMatch(/SUPABASE|KEY|SECRET|TOKEN|PASSWORD|DSN/);
      }
    }
    expect(read("eas.json")).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sk_(live|test)_|-----BEGIN/);
  });

  it("uses no EAS Update channel, because Compass ships no expo-updates", () => {
    const deps = readJson("package.json")["dependencies"] as Record<string, string>;
    expect(deps["expo-updates"]).toBeUndefined();
    for (const profile of Object.values(easJson.build)) expect(profile["channel"]).toBeUndefined();
  });

  it("submits iOS to TestFlight and Android to the internal track only", async () => {
    // Until the owner fills them, eas-cli itself refuses the iOS values, so nothing half-configured submits.
    await expect(
      easJsonLib.EasJsonUtils.getSubmitProfileAsync(accessor, "ios", "production"),
    ).rejects.toThrow(/ascAppId/);
    expect(easJson.submit["production"]?.["ios"]).toMatchObject({
      ascAppId: "OWNER_ASC_APP_ID",
      appleTeamId: "OWNER_APPLE_TEAM_ID",
      metadataPath: "./store/store.config.json",
    });
    const android = await easJsonLib.EasJsonUtils.getSubmitProfileAsync(
      accessor,
      "android",
      "production",
    );
    expect(android).toMatchObject({ track: "internal", releaseStatus: "completed" });
    expect(android["serviceAccountKeyPath"]).toBe("OWNER_PLAY_SERVICE_ACCOUNT_KEY_PATH");
    const draft = await easJsonLib.EasJsonUtils.getSubmitProfileAsync(
      accessor,
      "android",
      "internal-draft",
    );
    expect(draft).toMatchObject({ track: "internal", releaseStatus: "draft" });
    for (const profile of Object.values(easJson.submit)) {
      expect(profile["android"]?.["track"] ?? "internal").toBe("internal");
    }
  });

  it("passes eas-cli's submit validation once the owner fills the iOS values", () => {
    const filled = { ascAppId: "1234567890", appleTeamId: "AB12CD34EF", language: "en-US" };
    expect(submitSchemas.ResolvedIosSubmitProfileSchema.validate(filled).error).toBeUndefined();
    expect(
      submitSchemas.ResolvedIosSubmitProfileSchema.validate(easJson.submit["production"]?.["ios"])
        .error,
    ).toBeDefined();
  });
});

/** The first 26 bytes of a PNG: signature, IHDR length and type, width, height, bit depth, colour type. */
function pngHeader(width: number, height: number, colorType: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = colorType;
  return bytes;
}
const goodIcon = pngHeader(1024, 1024, 2);

describe("store preflight", () => {
  const storeConfig = readJson("store/store.config.json");
  const base: PreflightInput = {
    easJson,
    storeConfig,
    appVersion: String(expo.version),
    fileExists: () => false,
    icon: goodIcon,
  };
  const filledEas = {
    ...easJson,
    submit: {
      production: {
        ios: { ascAppId: "1234567890", appleTeamId: "AB12CD34EF" },
        android: { serviceAccountKeyPath: "../../.secrets/play.json", track: "internal" },
      },
    },
  };

  it("refuses while account values are still owner values", () => {
    expect(preflightProblems("ios", base).join("\n")).toContain("OWNER_ASC_APP_ID");
    expect(preflightProblems("android", base).join("\n")).toContain(
      "OWNER_PLAY_SERVICE_ACCOUNT_KEY_PATH",
    );
    expect(preflightProblems("metadata", base).join("\n")).toContain("OWNER_");
  });

  it("passes once the owner has filled them", () => {
    expect(preflightProblems("ios", { ...base, easJson: filledEas })).toEqual([]);
    expect(
      preflightProblems("android", { ...base, easJson: filledEas, fileExists: () => true }),
    ).toEqual([]);
    expect(preflightProblems("android", { ...base, easJson: filledEas })).toEqual([
      "the Google service account key ../../.secrets/play.json does not exist",
    ]);
  });

  it("accepts a service account stored on EAS instead of a file", () => {
    const withoutPath = {
      submit: { production: { android: { track: "internal", releaseStatus: "completed" } } },
    };
    expect(preflightProblems("android", { ...base, easJson: withoutPath })).toEqual([]);
  });

  it("never lets the store commands promote or release on their own", () => {
    const production = {
      submit: { production: { android: { track: "production" } } },
    };
    expect(preflightProblems("android", { ...base, easJson: production }).join("\n")).toContain(
      "owner stop point",
    );
    const automatic = {
      apple: { version: expo.version, release: { automaticRelease: true } },
    };
    expect(preflightProblems("metadata", { ...base, storeConfig: automatic }).join("\n")).toContain(
      "owner stop point",
    );
  });

  it("asks for the owner's app icon, 1024 x 1024 and without transparency", () => {
    expect(iconProblems(goodIcon)).toEqual([]);
    expect(iconProblems(null)[0]).toMatch(/assets\/icon\.png is missing/);
    expect(iconProblems(pngHeader(1024, 1024, 6))).toEqual([
      "assets/icon.png has an alpha channel; export it without transparency",
    ]);
    expect(iconProblems(pngHeader(512, 512, 2))).toEqual([
      "assets/icon.png is 512 x 512, not 1024 x 1024",
    ]);
    expect(iconProblems(new Uint8Array(30))).toEqual(["assets/icon.png is not a PNG"]);
    const noIcon = { ...base, icon: null };
    expect(preflightProblems("ios", noIcon).join("\n")).toContain("assets/icon.png is missing");
    expect(preflightProblems("android", noIcon).join("\n")).toContain("assets/icon.png is missing");
    expect(preflightProblems("metadata", noIcon).join("\n")).not.toContain("assets/icon.png");
  });

  it("lists owner values with their JSON path", () => {
    expect(ownerValues({ a: [{ b: "x OWNER_ONE y OWNER_TWO" }] })).toEqual([
      "a[0].b: OWNER_ONE",
      "a[0].b: OWNER_TWO",
    ]);
  });

  it("runs before every store command", () => {
    const scripts = readJson("package.json")["scripts"] as Record<string, string>;
    expect(scripts["release:ios"]).toMatch(
      /store-preflight\.ts ios && eas build --platform ios --profile production --auto-submit/,
    );
    expect(scripts["release:android"]).toMatch(
      /store-preflight\.ts android && eas build --platform android --profile production --auto-submit/,
    );
    expect(scripts["store:metadata"]).toMatch(/store-preflight\.ts metadata && eas metadata:push/);
  });
});

describe("release build guard (app.config.ts)", () => {
  const good = {
    EAS_BUILD: "true",
    EAS_BUILD_PROFILE: "production",
    EXPO_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key",
    EXPO_PUBLIC_ATLAS_URL: "https://app.example.com",
    EXPO_PUBLIC_GATEWAY_URL: "https://gateway.example.com",
  };

  it("lets a complete release build through", () => {
    expect(releaseConfigProblems(good)).toEqual([]);
  });

  it("stops a preview or production build on EAS that would talk to a local stack", () => {
    const local = { ...good, EXPO_PUBLIC_SUPABASE_URL: "http://127.0.0.1:56021" };
    expect(releaseConfigProblems(local)).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL must be an https URL that is not local (EAS environment "production")',
    ]);
    const missing = { EAS_BUILD: "true", EAS_BUILD_PROFILE: "preview" };
    expect(releaseConfigProblems(missing)).toHaveLength(4);
    expect(() => withStoreBuild(expo, missing, true)).toThrow(/eas env:create/);
  });

  it("stops a release build without the app icon and uses the icon once it exists", () => {
    expect(releaseConfigProblems(good, false)).toEqual([
      'the app icon ./assets/icon.png (1024 x 1024 PNG, no transparency) is missing (EAS environment "production")',
    ]);
    expect(() => withStoreBuild(expo, good)).toThrow(/app icon/);
    expect(withStoreBuild(expo, good, true).icon).toBe("./assets/icon.png");
    expect(withStoreBuild(expo, {}).icon).toBeUndefined();
  });

  it("never stops a local or development build", () => {
    expect(releaseConfigProblems({})).toEqual([]);
    expect(releaseConfigProblems({ EAS_BUILD: "true", EAS_BUILD_PROFILE: "development" })).toEqual(
      [],
    );
    expect(releaseConfigProblems({ EAS_BUILD_PROFILE: "production" })).toEqual([]);
  });

  it("takes the Apple team id and the Firebase file from the EAS environment", () => {
    const out = withStoreBuild(
      expo,
      {
        ...good,
        XOS_APPLE_TEAM_ID: "AB12CD34EF",
        GOOGLE_SERVICES_JSON: "/tmp/google-services.json",
      },
      true,
    );
    expect(out.ios?.appleTeamId).toBe("AB12CD34EF");
    expect(out.android?.googleServicesFile).toBe("/tmp/google-services.json");
    const ignored = withStoreBuild(expo, { XOS_APPLE_TEAM_ID: "OWNER_APPLE_TEAM_ID" });
    expect(ignored.ios?.appleTeamId).toBeUndefined();
    expect(ignored.android?.googleServicesFile).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------------
 * iOS privacy: the privacy manifest covers every required-reason API that Compass and its iOS
 * dependencies declare, and every purpose string is plain language.
 */

interface ManifestEntry {
  readonly category: string;
  readonly reasons: readonly string[];
}

/** NSPrivacyAccessedAPITypes of a PrivacyInfo.xcprivacy file (an XML plist). */
function accessedApis(plist: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const dict =
    /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/g;
  for (const m of plist.matchAll(dict)) {
    entries.push({
      category: m[1] ?? "",
      reasons: [...(m[2] ?? "").matchAll(/<string>([^<]+)<\/string>/g)].map((r) => r[1] ?? ""),
    });
  }
  return entries;
}

function packageDir(fromDir: string, name: string): string | null {
  try {
    return dirname(
      realpathSync(createRequire(join(fromDir, "noop.js")).resolve(`${name}/package.json`)),
    );
  } catch {
    return null;
  }
}

function isNative(dir: string): boolean {
  if (existsSync(join(dir, "expo-module.config.json"))) return true;
  return [dir, join(dir, "ios")].some(
    (d) => existsSync(d) && readdirSync(d).some((f) => f.endsWith(".podspec")),
  );
}

/** The iOS native packages Compass links: its dependencies and, through them, theirs. */
function nativePackages(): string[] {
  const seen = new Set<string>();
  const queue: string[] = [compassDir];
  const found: string[] = [];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const depDir = packageDir(dir, name);
      if (!depDir || seen.has(depDir)) continue;
      seen.add(depDir);
      if (!isNative(depDir)) continue;
      found.push(depDir);
      queue.push(depDir);
    }
  }
  return found;
}

function privacyManifests(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (["node_modules", "android", "example", "__tests__", "build"].includes(entry)) return [];
    const path = join(dir, entry);
    if (entry === "PrivacyInfo.xcprivacy") return [path];
    try {
      return statSync(path).isDirectory() ? privacyManifests(path, depth + 1) : [];
    } catch {
      return [];
    }
  });
}

describe("iOS privacy manifest", () => {
  const manifest = expo.ios?.privacyManifests as {
    NSPrivacyTracking: boolean;
    NSPrivacyAccessedAPITypes: {
      NSPrivacyAccessedAPIType: string;
      NSPrivacyAccessedAPITypeReasons: string[];
    }[];
    NSPrivacyCollectedDataTypes: {
      NSPrivacyCollectedDataType: string;
      NSPrivacyCollectedDataTypeTracking: boolean;
      NSPrivacyCollectedDataTypeLinked: boolean;
      NSPrivacyCollectedDataTypePurposes: string[];
    }[];
  };
  const declared = new Map(
    manifest.NSPrivacyAccessedAPITypes.map((t) => [
      t.NSPrivacyAccessedAPIType,
      new Set(t.NSPrivacyAccessedAPITypeReasons),
    ]),
  );

  it("declares every required reason the iOS dependencies declare", () => {
    const packages = nativePackages();
    expect(packages.some((p) => p.includes("react-native@"))).toBe(true);
    expect(packages.some((p) => p.includes("expo-file-system@"))).toBe(true);
    const missing: string[] = [];
    for (const dir of packages) {
      for (const file of privacyManifests(dir)) {
        for (const entry of accessedApis(readFileSync(file, "utf8"))) {
          for (const reason of entry.reasons) {
            if (!declared.get(entry.category)?.has(reason)) {
              missing.push(`${entry.category} ${reason} (${file.split("node_modules/").pop()})`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("declares the App Group defaults Compass shares with its widget, in both bundles", () => {
    const shared = read("modules/compass-live-activity/ios/ClockActivityAttributes.swift");
    expect(shared).toMatch(/UserDefaults\(suiteName:/);
    expect(declared.get("NSPrivacyAccessedAPICategoryUserDefaults")).toContain("1C8F.1");
    const widget = accessedApis(read("targets/ClockActivity/PrivacyInfo.xcprivacy"));
    expect(widget).toEqual([
      { category: "NSPrivacyAccessedAPICategoryUserDefaults", reasons: ["1C8F.1"] },
    ]);
  });

  it("declares SQLite's file and disk-space calls, which op-sqlite ships without a manifest", () => {
    expect(declared.get("NSPrivacyAccessedAPICategoryFileTimestamp")).toContain("C617.1");
    expect(declared.get("NSPrivacyAccessedAPICategoryDiskSpace")).toContain("E174.1");
    expect(declared.get("NSPrivacyAccessedAPICategorySystemBootTime")).toContain("35F9.1");
  });

  it("tracks no one and collects data only for the app to work", () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
    for (const t of manifest.NSPrivacyCollectedDataTypes) {
      expect(t.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(t.NSPrivacyCollectedDataTypePurposes).toEqual([
        "NSPrivacyCollectedDataTypePurposeAppFunctionality",
      ]);
    }
    const types = manifest.NSPrivacyCollectedDataTypes.map((t) => t.NSPrivacyCollectedDataType);
    expect(types).toContain("NSPrivacyCollectedDataTypePreciseLocation");
    expect(types).not.toContain("NSPrivacyCollectedDataTypeCrashData");
  });

  it("encrypts the offline database with SQLCipher on iOS too", () => {
    // op-sqlite's podspec reads its options from the first package.json above its own folder, which in
    // this pnpm workspace is the repository root, so the root carries the same options as Compass.
    const root = JSON.parse(readFileSync(join(compassDir, "../../package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(root["op-sqlite"]).toEqual(readJson("package.json")["op-sqlite"]);
    expect(root["op-sqlite"]).toEqual({ sqlcipher: true });
  });
});

describe("purpose strings", () => {
  const plugins = new Map(
    (expo.plugins ?? []).map((p) => (Array.isArray(p) ? [p[0], p[1] ?? {}] : [p, {}])),
  ) as Map<string, Record<string, unknown>>;
  const infoPlist = (expo.ios?.infoPlist ?? {}) as Record<string, unknown>;
  const strings: Record<string, unknown> = {
    ...infoPlist,
    camera: plugins.get("expo-camera")?.["cameraPermission"],
    microphone: plugins.get("expo-audio")?.["microphonePermission"],
    whenInUse: plugins.get("expo-location")?.["locationWhenInUsePermission"],
    always: plugins.get("expo-location")?.["locationAlwaysPermission"],
    alwaysAndWhenInUse: plugins.get("expo-location")?.["locationAlwaysAndWhenInUsePermission"],
    motion: plugins.get("expo-location")?.["motionUsagePermission"],
    faceId: plugins.get("expo-local-authentication")?.["faceIDPermission"],
  };

  it("says in plain language what Compass does with each permission", () => {
    for (const [key, value] of Object.entries(strings)) {
      if (!/UsageDescription$|^[a-z]/.test(key)) continue;
      expect(typeof value, key).toBe("string");
      expect(value as string, key).toMatch(/^Compass /);
      expect(value as string, key).not.toMatch(/\$\(PRODUCT_NAME\)|^Allow /);
    }
  });

  it("declares Spanish in the iOS bundle and asks for every permission in Spanish too", () => {
    // Without a Spanish localization in the bundle, iOS reports the app's locale as English and Compass
    // (which reads the locale through Intl) stays in English on a Spanish iPhone.
    expect((expo as { locales?: Record<string, string> }).locales).toEqual({
      es: "./locales/es.json",
    });
    expect(infoPlist["CFBundleAllowMixedLocalizations"]).toBe(true);
    const es = (readJson("locales/es.json") as { ios: Record<string, string> }).ios;
    for (const key of [
      "NSCameraUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSLocationWhenInUseUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
      "NSLocationAlwaysUsageDescription",
      "NSMotionUsageDescription",
      "NSFaceIDUsageDescription",
    ]) {
      expect(es[key], key).toMatch(/^Compass /);
    }
    expect(es["CFBundleDisplayName"]).toBe(expo.name);
  });

  it("asks for no photo library access, because photos come only from the camera", () => {
    const deps = readJson("package.json")["dependencies"] as Record<string, string>;
    expect(deps["expo-image-picker"]).toBeUndefined();
    expect(deps["expo-media-library"]).toBeUndefined();
    expect(Object.keys(infoPlist).filter((k) => k.startsWith("NSPhotoLibrary"))).toEqual([]);
  });

  it("runs nothing in the background except the Live Activity", () => {
    expect(infoPlist["UIBackgroundModes"]).toBeUndefined();
    expect(plugins.get("expo-audio")).toMatchObject({
      enableBackgroundPlayback: false,
      enableBackgroundRecording: false,
    });
    expect(plugins.get("expo-location")).toMatchObject({
      isIosBackgroundLocationEnabled: false,
      isAndroidBackgroundLocationEnabled: false,
    });
  });
});

describe("Android permissions and target SDK", () => {
  const android = expo.android as { permissions: string[]; blockedPermissions: string[] };

  it("asks only for what a Compass feature uses", () => {
    expect([...android.permissions].sort()).toEqual(
      [
        "ACCESS_COARSE_LOCATION",
        "ACCESS_FINE_LOCATION",
        "CAMERA",
        "RECORD_AUDIO",
        "USE_BIOMETRIC",
      ].sort(),
    );
  });

  it("removes permissions that libraries add but Compass never uses", () => {
    expect(android.blockedPermissions).toEqual(
      expect.arrayContaining([
        "android.permission.WRITE_SETTINGS",
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "com.google.android.gms.permission.AD_ID",
      ]),
    );
    // expo-brightness sets only the window's brightness here, which needs no permission.
    const scan = read("app/(tabs)/scan.tsx");
    expect(scan).toContain("Brightness.setBrightnessAsync");
    expect(scan).not.toContain("setSystemBrightnessAsync");
  });

  it("targets at least the API level Google Play requires (Android 16, API 36)", () => {
    const rn = dirname(realpathSync(join(compassDir, "node_modules/react-native/package.json")));
    const catalog = readFileSync(join(rn, "gradle/libs.versions.toml"), "utf8");
    const target = Number(/^targetSdk = "(\d+)"/m.exec(catalog)?.[1]);
    expect(target).toBeGreaterThanOrEqual(36);
    expect(JSON.stringify(expo)).not.toMatch(/targetSdkVersion/);
  });
});
