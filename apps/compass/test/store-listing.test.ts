import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Store listings (RRR-113): the App Store metadata for `eas metadata:push` and the Play listing. */
const compassDir = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(compassDir, path), "utf8");

interface AppleInfo {
  title: string;
  subtitle: string;
  promoText: string;
  description: string;
  keywords: string[];
  releaseNotes: string;
  marketingUrl: string;
  supportUrl: string;
  privacyPolicyUrl: string;
  screenshots: Record<string, string[]>;
}
interface PlayListing {
  title: string;
  shortDescription: string;
  fullDescription: string;
  whatsNew: string;
  phoneScreenshots: string[];
}

const storeConfig = JSON.parse(read("store/store.config.json")) as {
  configVersion: number;
  apple: {
    version: string;
    categories: string[];
    info: Record<string, AppleInfo>;
    advisory: Record<string, unknown>;
    review: Record<string, unknown> & { notes: string };
    release: { automaticRelease: boolean };
  };
};
const play = JSON.parse(read("store/google-play/listing.json")) as {
  packageName: string;
  category: string;
  contact: Record<string, string>;
  listings: Record<string, PlayListing>;
};
const appJson = JSON.parse(read("app.json")) as {
  expo: { version: string; ios: { bundleIdentifier: string } };
};

/** eas-cli's own store.config.json validator: the JSON schema plus its Apple rules. */
const requireFromEasCli = createRequire(
  realpathSync(join(compassDir, "node_modules/eas-cli/package.json")),
);
const { validateConfig } = requireFromEasCli("./build/metadata/config/validate.js") as {
  validateConfig(config: unknown): { severity: number; message: string; path: string[] }[];
};

const IOS_ONLY =
  /\b(Siri|Live Activit(y|ies)|Lock Screen|Action Button|Face ID|Touch ID|App Store|iPhone|iOS|Actividad en vivo|pantalla bloqueada|botón de Acción)\b/;
const ANDROID_ONLY = /\b(Android|Google Play|Play Store)\b/;

describe("App Store listing (store/store.config.json)", () => {
  it("passes eas-cli's metadata validation, so `eas metadata:push` accepts it", () => {
    expect(validateConfig(storeConfig)).toEqual([]);
  });

  it("describes this version of this app", () => {
    expect(storeConfig.apple.version).toBe(appJson.expo.version);
    expect(play.packageName).toBe(appJson.expo.ios.bundleIdentifier);
    expect(storeConfig.apple.categories).toEqual(["BUSINESS", "PRODUCTIVITY"]);
    expect(play.category).toBe("Business");
  });

  it("has an English (U.S.) listing and the es-US copy as Spanish (Mexico)", () => {
    // App Store Connect has no es-US localization; Spanish (Mexico) serves Spanish speakers in the US.
    expect(Object.keys(storeConfig.apple.info).sort()).toEqual(["en-US", "es-MX"]);
    expect(Object.keys(play.listings).sort()).toEqual(["en-US", "es-US"]);
  });

  it("keeps every field inside App Store Connect's limits", () => {
    for (const [locale, info] of Object.entries(storeConfig.apple.info)) {
      expect(info.title.length, locale).toBeLessThanOrEqual(30);
      expect(info.subtitle.length, locale).toBeLessThanOrEqual(30);
      expect(info.promoText.length, locale).toBeLessThanOrEqual(170);
      expect(info.description.length, locale).toBeLessThanOrEqual(4000);
      expect(info.releaseNotes.length, locale).toBeLessThanOrEqual(4000);
      // Keywords: 100 bytes, comma separated, no word from the app name.
      expect(Buffer.byteLength(info.keywords.join(","), "utf8"), locale).toBeLessThanOrEqual(100);
      for (const k of info.keywords) expect(k.toLowerCase(), locale).not.toMatch(/compass|xos/);
      for (const url of [info.marketingUrl, info.supportUrl, info.privacyPolicyUrl]) {
        expect(url, locale).toMatch(/^https:\/\//);
      }
    }
  });

  it("never releases on its own and answers every age rating question", () => {
    expect(storeConfig.apple.release.automaticRelease).toBe(false);
    const advisory = storeConfig.apple.advisory;
    expect(advisory["messagingAndChat"]).toBe(true);
    expect(advisory["userGeneratedContent"]).toBe(true);
    expect(advisory["advertising"]).toBe(false);
    expect(advisory["unrestrictedWebAccess"]).toBe(false);
    expect(advisory["kidsAgeBand"]).toBeNull();
    expect(advisory["ageRatingOverrideV2"]).toBeNull();
  });

  it("holds no demo password, and the review notes match store/review-notes.md", () => {
    expect(storeConfig.apple.review["demoPassword"]).toBeUndefined();
    expect(storeConfig.apple.review["demoRequired"]).toBe(true);
    const md = read("store/review-notes.md");
    const block = /## App Review notes\n\n```text\n([\s\S]*?)\n```/.exec(md)?.[1];
    expect(block).toBe(storeConfig.apple.review.notes);
    expect(storeConfig.apple.review.notes.length).toBeLessThanOrEqual(4000);
    const seed = readFileSync(
      join(compassDir, "../../supabase/seeds/0010_demo_identity.sql"),
      "utf8",
    );
    const seedPassword = /extensions\.crypt\('([^']+)'/.exec(seed)?.[1] ?? "unset";
    for (const file of [
      "store/store.config.json",
      "store/review-notes.md",
      "store/google-play/listing.json",
    ]) {
      expect(read(file), file).not.toContain(seedPassword);
    }
  });
});

describe("Google Play listing (store/google-play/listing.json)", () => {
  it("keeps every field inside Play Console's limits", () => {
    for (const [locale, l] of Object.entries(play.listings)) {
      expect(l.title.length, locale).toBeLessThanOrEqual(30);
      expect(l.shortDescription.length, locale).toBeLessThanOrEqual(80);
      expect(l.fullDescription.length, locale).toBeLessThanOrEqual(4000);
      expect(l.whatsNew.length, locale).toBeLessThanOrEqual(500);
    }
  });

  it("names no other platform in either store", () => {
    for (const [locale, l] of Object.entries(play.listings)) {
      expect(`${l.shortDescription}\n${l.fullDescription}\n${l.whatsNew}`, locale).not.toMatch(
        IOS_ONLY,
      );
    }
    for (const [locale, info] of Object.entries(storeConfig.apple.info)) {
      expect(`${info.subtitle}\n${info.promoText}\n${info.description}`, locale).not.toMatch(
        ANDROID_ONLY,
      );
    }
  });

  it("names the same app in both stores and links the account deletion page", () => {
    for (const l of Object.values(play.listings))
      expect(l.title).toBe(storeConfig.apple.info["en-US"]?.title);
    expect(play.contact["accountDeletionUrl"]).toMatch(/\/legal\/account-deletion$/);
    expect(play.contact["privacyPolicyUrl"]).toBe(
      storeConfig.apple.info["en-US"]?.privacyPolicyUrl,
    );
  });
});
