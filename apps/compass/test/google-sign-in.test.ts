import type { ExpoConfig } from "expo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { googleIosUrlScheme, withGoogleSignIn } from "../app.config";
import {
  googleSignInAvailable,
  idTokenRefusal,
  readGoogleClientIds,
  signInWithGoogle,
  type IdTokenAuth,
} from "../src/domain/googleSignIn";

/**
 * Sign in with Google on Compass (ADR 0036, RRR-117). The native SDK is replaced, so the tests run in
 * node and never reach Google. The client IDs are the documented example shape, not real clients.
 */

const WEB = "123456789012-abc123def456ghi789jkl012mno345pq.apps.googleusercontent.com";
const IOS = "123456789012-zyx987wvu654tsr321qpo098nml765kj.apps.googleusercontent.com";

const sdk = vi.hoisted(() => ({
  configure: vi.fn(),
  hasPlayServices: vi.fn(async () => true),
  signIn: vi.fn(),
  signOut: vi.fn(async () => null),
  hasPreviousSignIn: vi.fn(() => true),
}));
const codes = vi.hoisted(() => ({
  SIGN_IN_CANCELLED: "12501",
  IN_PROGRESS: "ASYNC_OP_IN_PROGRESS",
  PLAY_SERVICES_NOT_AVAILABLE: "PLAY_SERVICES_NOT_AVAILABLE",
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED",
}));
vi.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: sdk,
  statusCodes: codes,
  isErrorWithCode: (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error,
}));
const platform = vi.hoisted(() => ({ OS: "ios" }));
vi.mock("react-native", () => ({ Platform: platform }));

const { forgetGoogleAccount, googleOffered, loadGoogleNative } =
  await import("../src/runtime/google");

function nativeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

let tokens: string[];
let refusal: { code?: string; status?: number; message: string } | null;
const auth: IdTokenAuth = {
  signInWithIdToken: async ({ token }) => {
    tokens.push(token);
    return { error: refusal };
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.hasPlayServices.mockResolvedValue(true);
  sdk.signIn.mockResolvedValue({ type: "success", data: { idToken: "google-id-token-for-tests" } });
  tokens = [];
  refusal = null;
  platform.OS = "ios";
  vi.unstubAllEnvs();
});

describe("Compass: Continue with Google", () => {
  it("configures the SDK with the client IDs and hands Google's ID token to Supabase Auth", async () => {
    const outcome = await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS });
    expect(outcome).toEqual({ kind: "signed-in" });
    expect(sdk.configure).toHaveBeenCalledWith({ webClientId: WEB, iosClientId: IOS });
    expect(sdk.hasPlayServices).toHaveBeenCalledWith({ showPlayServicesUpdateDialog: true });
    expect(tokens).toEqual(["google-id-token-for-tests"]);
  });

  it("leaves the iOS client ID out on Android", async () => {
    platform.OS = "android";
    await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: null });
    expect(sdk.configure).toHaveBeenCalledWith({ webClientId: WEB });
  });

  it("treats closing Google's picker, or a sign-in already showing, as nothing to report", async () => {
    sdk.signIn.mockResolvedValueOnce({ type: "cancelled", data: null });
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS })).toEqual({
      kind: "cancelled",
    });
    for (const code of [codes.SIGN_IN_CANCELLED, codes.IN_PROGRESS]) {
      sdk.signIn.mockRejectedValueOnce(nativeError(code));
      expect(
        await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS }),
      ).toEqual({ kind: "cancelled" });
    }
    expect(tokens).toEqual([]);
  });

  it("says when Google Play services are missing, and when Google fails", async () => {
    sdk.hasPlayServices.mockResolvedValueOnce(false);
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: null })).toEqual(
      {
        kind: "refused",
        message: "googleUnavailable",
      },
    );
    sdk.hasPlayServices.mockRejectedValueOnce(nativeError(codes.PLAY_SERVICES_NOT_AVAILABLE));
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: null })).toEqual(
      {
        kind: "refused",
        message: "googleUnavailable",
      },
    );
    sdk.signIn.mockRejectedValueOnce(nativeError("DEVELOPER_ERROR"));
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS })).toEqual({
      kind: "refused",
      message: "googleFailed",
    });
    sdk.signIn.mockRejectedValueOnce(new TypeError("not a native error"));
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS })).toEqual({
      kind: "refused",
      message: "googleFailed",
    });
    sdk.signIn.mockResolvedValueOnce({ type: "success", data: { idToken: null } });
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS })).toEqual({
      kind: "refused",
      message: "googleFailed",
    });
    expect(tokens).toEqual([]);
  });

  it("maps Supabase Auth's refusals of the ID token to messages", async () => {
    refusal = {
      code: "provider_email_needs_verification",
      status: 400,
      message: "Unverified email",
    };
    expect(await signInWithGoogle(await loadGoogleNative(), auth, { web: WEB, ios: IOS })).toEqual({
      kind: "refused",
      message: "emailNotVerified",
    });
    expect(idTokenRefusal({ code: "sso_required", message: "" })).toBe("ssoRequired");
    expect(idTokenRefusal({ status: 0, message: "Failed to fetch" })).toBe("network");
    expect(idTokenRefusal({ code: "bad_jwt", status: 400, message: "Bad ID token" })).toBe(
      "googleFailed",
    );
  });

  it("forgets the Google account on sign-out so the next sign-in shows the picker", async () => {
    vi.stubEnv("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID", WEB);
    vi.stubEnv("EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID", IOS);
    await forgetGoogleAccount();
    expect(sdk.signOut).toHaveBeenCalledTimes(1);

    sdk.signOut.mockRejectedValueOnce(nativeError("SIGN_OUT_FAILED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(forgetGoogleAccount()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    vi.unstubAllEnvs();
    sdk.signOut.mockClear();
    await forgetGoogleAccount();
    expect(sdk.signOut).not.toHaveBeenCalled();
  });
});

describe("Compass: Google configuration", () => {
  it("reads the public client IDs and offers Google only where they are complete", () => {
    expect(readGoogleClientIds({})).toBeNull();
    expect(readGoogleClientIds({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: "not-a-client-id" })).toBeNull();
    const webOnly = readGoogleClientIds({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: ` ${WEB} ` });
    expect(webOnly).toEqual({ web: WEB, ios: null });
    expect(googleSignInAvailable(webOnly, "android")).toBe(true);
    expect(googleSignInAvailable(webOnly, "ios")).toBe(false);
    const both = readGoogleClientIds({
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: WEB,
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: IOS,
    });
    expect(googleSignInAvailable(both, "ios")).toBe(true);
    expect(googleSignInAvailable(both, "web")).toBe(false);
    expect(googleSignInAvailable(null, "android")).toBe(false);
  });

  it("offers Google from the build's environment", () => {
    expect(googleOffered()).toBe(false);
    vi.stubEnv("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID", WEB);
    platform.OS = "android";
    expect(googleOffered()).toBe(true);
  });

  it("adds the SDK's plugin with the reversed iOS client ID, and nothing without one", () => {
    expect(googleIosUrlScheme(IOS)).toBe(
      "com.googleusercontent.apps.123456789012-zyx987wvu654tsr321qpo098nml765kj",
    );
    expect(googleIosUrlScheme(undefined)).toBeNull();
    expect(googleIosUrlScheme("com.example.app")).toBeNull();
    const base = { name: "Compass", slug: "xos-compass", plugins: ["expo-router"] } as ExpoConfig;
    expect(withGoogleSignIn(base, undefined)).toBe(base);
    expect(withGoogleSignIn(base, IOS).plugins).toEqual([
      "expo-router",
      [
        "@react-native-google-signin/google-signin",
        {
          iosUrlScheme: "com.googleusercontent.apps.123456789012-zyx987wvu654tsr321qpo098nml765kj",
        },
      ],
    ]);
  });
});
