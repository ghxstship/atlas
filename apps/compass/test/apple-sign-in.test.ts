import { createHash } from "node:crypto";
import type { ExpoConfig } from "expo/config";
import { describe, expect, it, vi } from "vitest";
import { withAppleSignIn } from "../app.config";
import {
  appleFullName,
  appleTokenRefusal,
  readAppleSignIn,
  revokeAppleBeforeDeletion,
  signedInWithApple,
  signInButtons,
  signInWithApple,
  type AppleCredential,
  type AppleIdTokenAuth,
  type AppleNative,
  type AppleRevokeCall,
  type NonceSource,
} from "../src/domain/appleSignIn";

/**
 * Sign in with Apple on Compass (ADR 0033 decision 58). The native module, the nonce source and Supabase Auth are fakes,
 * so the tests run in node and never reach Apple. The Google client IDs are the documented example shape.
 */

const WEB = "123456789012-abc123def456ghi789jkl012mno345pq.apps.googleusercontent.com";
const IOS = "123456789012-zyx987wvu654tsr321qpo098nml765kj.apps.googleusercontent.com";
const BOTH = { web: WEB, ios: IOS };

describe("which sign-in buttons show", () => {
  it("reads the build's explicit switch", () => {
    expect(readAppleSignIn({ EXPO_PUBLIC_APPLE_SIGN_IN: "1" })).toBe(true);
    expect(readAppleSignIn({ EXPO_PUBLIC_APPLE_SIGN_IN: " TRUE " })).toBe(true);
    expect(readAppleSignIn({ EXPO_PUBLIC_APPLE_SIGN_IN: "0" })).toBe(false);
    expect(readAppleSignIn({ EXPO_PUBLIC_APPLE_SIGN_IN: "yes" })).toBe(false);
    expect(readAppleSignIn({})).toBe(false);
  });

  it("on iOS shows Apple when the build turned it on and the device offers it, and Google only beside it", () => {
    const ios = { platform: "ios", googleIds: BOTH };
    expect(signInButtons({ ...ios, appleConfigured: true, appleAvailable: true })).toEqual({
      apple: true,
      google: true,
    });
    // A build without Apple configured shows neither, whatever Google's client IDs.
    expect(signInButtons({ ...ios, appleConfigured: false, appleAvailable: false })).toEqual({
      apple: false,
      google: false,
    });
    // Configured, but the device does not offer it (or has not answered yet): still neither.
    expect(signInButtons({ ...ios, appleConfigured: true, appleAvailable: false })).toEqual({
      apple: false,
      google: false,
    });
    // Apple without the iOS Google client: Apple alone.
    expect(
      signInButtons({
        platform: "ios",
        appleConfigured: true,
        appleAvailable: true,
        googleIds: { web: WEB, ios: null },
      }),
    ).toEqual({ apple: true, google: false });
  });

  it("on Android and the web keeps Google as before and never shows Apple", () => {
    for (const appleConfigured of [true, false]) {
      expect(
        signInButtons({
          platform: "android",
          appleConfigured,
          appleAvailable: true,
          googleIds: BOTH,
        }),
      ).toEqual({ apple: false, google: true });
      expect(
        signInButtons({ platform: "web", appleConfigured, appleAvailable: true, googleIds: BOTH }),
      ).toEqual({ apple: false, google: false });
    }
    expect(
      signInButtons({
        platform: "android",
        appleConfigured: true,
        appleAvailable: true,
        googleIds: null,
      }),
    ).toEqual({ apple: false, google: false });
  });
});

/** A nonce source with a fixed nonce and a real SHA-256, as expo-crypto computes it (lowercase hex). */
const RAW = "f1e2d3c4b5a6978877665544332211000112233445566778899aabbccddeeff0";
const nonces: NonceSource = {
  random: () => RAW,
  sha256: async (value) => createHash("sha256").update(value).digest("hex"),
};

function native(
  credential: AppleCredential | Error,
  failure: AppleNative["failure"] = () => "other",
  reauthorization: string | null | Error = "fresh-authorization-code",
) {
  return {
    signIn: vi.fn<AppleNative["signIn"]>(async () => {
      if (credential instanceof Error) throw credential;
      return credential;
    }),
    reauthorize: vi.fn<AppleNative["reauthorize"]>(async () => {
      if (reauthorization instanceof Error) throw reauthorization;
      return reauthorization;
    }),
    failure: vi.fn(failure),
  } satisfies AppleNative;
}

function auth(error: { code?: string; status?: number; message: string } | null = null) {
  return {
    signInWithIdToken: vi.fn<AppleIdTokenAuth["signInWithIdToken"]>(async () => ({ error })),
  } satisfies AppleIdTokenAuth;
}

const CREDENTIAL: AppleCredential = {
  identityToken: "header.payload.signature",
  givenName: "Ana",
  familyName: "Reyes",
};

describe("the nonce flow", () => {
  it("gives Apple the nonce's SHA-256 and Supabase Auth the nonce itself", async () => {
    const apple = native(CREDENTIAL);
    const supabase = auth();
    expect(await signInWithApple(apple, supabase, nonces)).toEqual({ kind: "signed-in" });
    const hashed = createHash("sha256").update(RAW).digest("hex");
    expect(apple.signIn).toHaveBeenCalledWith({ hashedNonce: hashed });
    expect(hashed).not.toBe(RAW);
    expect(supabase.signInWithIdToken).toHaveBeenCalledWith({
      provider: "apple",
      token: "header.payload.signature",
      nonce: RAW,
    });
  });

  it("makes a new nonce for every sign-in", async () => {
    let n = 0;
    const counting: NonceSource = { random: () => `nonce-${++n}`, sha256: nonces.sha256 };
    const supabase = auth();
    await signInWithApple(native(CREDENTIAL), supabase, counting);
    await signInWithApple(native(CREDENTIAL), supabase, counting);
    expect(supabase.signInWithIdToken.mock.calls.map(([c]) => c.nonce)).toEqual([
      "nonce-1",
      "nonce-2",
    ]);
  });

  it("keeps the name Apple sends on a first sign-in, and signs in even when keeping it fails", async () => {
    const saveName = vi.fn(async () => undefined);
    await signInWithApple(native(CREDENTIAL), auth(), nonces, saveName);
    expect(saveName).toHaveBeenCalledWith({
      givenName: "Ana",
      familyName: "Reyes",
      fullName: "Ana Reyes",
    });
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await signInWithApple(native(CREDENTIAL), auth(), nonces, failing)).toEqual({
      kind: "signed-in",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const noName = vi.fn(async () => undefined);
    await signInWithApple(
      native({ ...CREDENTIAL, givenName: null, familyName: "  " }),
      auth(),
      nonces,
      noName,
    );
    expect(noName).not.toHaveBeenCalled();
  });

  it("treats a closed sheet as cancelled and other native failures as refusals", async () => {
    const supabase = auth();
    expect(
      await signInWithApple(
        native(new Error("closed"), () => "cancelled"),
        supabase,
        nonces,
      ),
    ).toEqual({ kind: "cancelled" });
    expect(
      await signInWithApple(
        native(new Error("no"), () => "unavailable"),
        supabase,
        nonces,
      ),
    ).toEqual({ kind: "refused", message: "appleUnavailable" });
    expect(await signInWithApple(native(new Error("boom")), supabase, nonces)).toEqual({
      kind: "refused",
      message: "appleFailed",
    });
    expect(supabase.signInWithIdToken).not.toHaveBeenCalled();
  });

  it("refuses a credential without an identity token", async () => {
    const supabase = auth();
    expect(
      await signInWithApple(native({ ...CREDENTIAL, identityToken: null }), supabase, nonces),
    ).toEqual({ kind: "refused", message: "appleFailed" });
    expect(supabase.signInWithIdToken).not.toHaveBeenCalled();
  });

  it("maps Supabase Auth's refusals as Google's are mapped", async () => {
    expect(
      await signInWithApple(
        native(CREDENTIAL),
        auth({ code: "bad_jwt", status: 400, message: "Nonces mismatch" }),
        nonces,
      ),
    ).toEqual({ kind: "refused", message: "appleFailed" });
    expect(appleTokenRefusal({ code: "provider_email_needs_verification", message: "x" })).toBe(
      "emailNotVerified",
    );
    expect(appleTokenRefusal({ code: "sso_required", message: "x" })).toBe("ssoRequired");
    expect(appleTokenRefusal({ status: 0, message: "Failed to fetch" })).toBe("network");
  });

  it("joins the name parts Apple sent", () => {
    expect(appleFullName(CREDENTIAL)).toBe("Ana Reyes");
    expect(appleFullName({ ...CREDENTIAL, familyName: null })).toBe("Ana");
    expect(appleFullName({ ...CREDENTIAL, givenName: " ", familyName: null })).toBeNull();
  });
});

describe("revoking Compass's Apple tokens before an account deletion", () => {
  function revoker(status: number, reason: string | null = null) {
    return vi.fn<AppleRevokeCall>(async () => ({ status, reason }));
  }

  it("knows an account that signs in with Apple by its identities", () => {
    expect(signedInWithApple([{ provider: "email" }, { provider: "apple" }])).toBe(true);
    expect(signedInWithApple([{ provider: "email" }, { provider: "google" }])).toBe(false);
    expect(signedInWithApple(undefined)).toBe(false);
  });

  it("hands a fresh authorization code to the function, and revokes", async () => {
    const apple = native(CREDENTIAL);
    const revoke = revoker(200);
    expect(
      await revokeAppleBeforeDeletion({
        signedInWithApple: true,
        appleOnDevice: true,
        native: async () => apple,
        revoke,
      }),
    ).toEqual({ kind: "revoked" });
    expect(apple.reauthorize).toHaveBeenCalledTimes(1);
    expect(apple.signIn).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("fresh-authorization-code");
  });

  it("does nothing for an account that does not sign in with Apple", async () => {
    const apple = native(CREDENTIAL);
    const revoke = revoker(200);
    expect(
      await revokeAppleBeforeDeletion({
        signedInWithApple: false,
        appleOnDevice: true,
        native: async () => apple,
        revoke,
      }),
    ).toEqual({ kind: "not-needed" });
    expect(apple.reauthorize).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("stops the deletion only when the person closes Apple's sheet", async () => {
    const revoke = revoker(200);
    expect(
      await revokeAppleBeforeDeletion({
        signedInWithApple: true,
        appleOnDevice: true,
        native: async () => native(CREDENTIAL, () => "cancelled", new Error("closed")),
        revoke,
      }),
    ).toEqual({ kind: "cancelled" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("lets the deletion go ahead, unrevoked, whenever Compass cannot revoke", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = { signedInWithApple: true, appleOnDevice: true };
    // No Apple sheet on this device (Android, or a build without Apple).
    const revoke = revoker(200);
    expect(
      await revokeAppleBeforeDeletion({
        ...base,
        appleOnDevice: false,
        native: async () => native(CREDENTIAL),
        revoke,
      }),
    ).toEqual({ kind: "not-revoked" });
    expect(revoke).not.toHaveBeenCalled();
    const outcomes = await Promise.all([
      // The function is not set up yet.
      revokeAppleBeforeDeletion({
        ...base,
        native: async () => native(CREDENTIAL),
        revoke: revoker(503, "apple_revoke_not_configured"),
      }),
      // Apple refused the code, or the network failed.
      revokeAppleBeforeDeletion({
        ...base,
        native: async () => native(CREDENTIAL),
        revoke: revoker(502, "apple_revoke_exchange_failed"),
      }),
      revokeAppleBeforeDeletion({
        ...base,
        native: async () => native(CREDENTIAL),
        revoke: vi.fn<AppleRevokeCall>(async () => {
          throw new Error("offline");
        }),
      }),
      // The sheet failed for another reason, or sent no code.
      revokeAppleBeforeDeletion({
        ...base,
        native: async () => native(CREDENTIAL, () => "other", new Error("boom")),
        revoke: revoker(200),
      }),
      revokeAppleBeforeDeletion({
        ...base,
        native: async () => native(CREDENTIAL, () => "other", null),
        revoke: revoker(200),
      }),
      // The native module did not load.
      revokeAppleBeforeDeletion({
        ...base,
        native: async () => {
          throw new Error("no module");
        },
        revoke: revoker(200),
      }),
    ]);
    expect(outcomes).toEqual(Array.from({ length: 6 }, () => ({ kind: "not-revoked" })));
    warn.mockRestore();
  });
});

describe("the build", () => {
  const base: ExpoConfig = { name: "Compass", slug: "xos-compass", plugins: ["expo-router"] };

  it("asks for the capability and adds the plugin only when Apple is turned on", () => {
    expect(withAppleSignIn(base, undefined)).toBe(base);
    expect(withAppleSignIn(base, "0")).toBe(base);
    const on = withAppleSignIn(base, "1");
    expect(on.ios?.usesAppleSignIn).toBe(true);
    expect(on.plugins).toEqual(["expo-router", "expo-apple-authentication"]);
  });
});
