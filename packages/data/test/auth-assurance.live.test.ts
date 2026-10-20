import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  finishPasskeyRegistration,
  finishPasskeySignIn,
  getAssurance,
  getSecondFactorStatus,
  listPasskeys,
  listSecondFactors,
  needsSecondFactor,
  removePasskey,
  removeSecondFactor,
  renamePasskey,
  renameSecondFactor,
  startPasskeyRegistration,
  startPasskeySignIn,
  startSecurityKeyChallenge,
  startSecurityKeyEnrollment,
  startTotpEnrollment,
  verifySecurityKey,
  verifyTotp,
} from "../src/auth-assurance.ts";
import type { XosClient } from "../src/client.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";
import { totp } from "./totp.ts";

/**
 * The full second-factor and passkey cycles against a running local Supabase stack (A77). Skipped unless
 * XOS_AUTH_LIVE_URL and XOS_AUTH_LIVE_ANON_KEY name the stack's API and anon key. XOS_AUTH_LIVE_ORIGIN is a
 * WebAuthn origin the stack's [auth.webauthn] rp_origins allow (http://localhost:3000 by default). Each run signs
 * up fresh test accounts; TOTP secrets and keys exist only for the run.
 */
const url = process.env["XOS_AUTH_LIVE_URL"];
const anonKey = process.env["XOS_AUTH_LIVE_ANON_KEY"];
const origin = process.env["XOS_AUTH_LIVE_ORIGIN"] ?? "http://localhost:3000";
const rp = { id: new URL(origin).hostname, origins: [origin] };

function newClient(): XosClient {
  const store = new Map<string, string>();
  return createClient(url as string, anonKey as string, {
    db: { schema: "app" },
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
      },
    },
  }) as unknown as XosClient;
}

async function signUp(): Promise<{ db: XosClient; email: string; password: string }> {
  const db = newClient();
  const email = `a77-${randomBytes(5).toString("hex")}@atlas-e2e.test`;
  const password = `Live-${randomBytes(12).toString("base64url")}`;
  const { error } = await db.auth.signUp({ email, password });
  if (error) throw error;
  return { db, email, password };
}

const unwrap = <T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};

describe.skipIf(!url || !anonKey)("authentication assurance on the local stack", () => {
  it("enrolls an authenticator app, challenges it at sign-in and steps up with it", async () => {
    const { db, email, password } = await signUp();
    const enrollment = unwrap(await startTotpEnrollment(db, "Phone"));
    expect(enrollment.qrCode).toMatch(/^data:image\/svg\+xml/);
    expect(await verifyTotp(db, enrollment.factorId, "000000")).toMatchObject({
      ok: false,
      error: { rule: "code_invalid" },
    });
    unwrap(await verifyTotp(db, enrollment.factorId, totp(enrollment.secret)));
    expect(unwrap(await getAssurance(db))).toEqual({ current: "aal2", next: "aal2" });
    expect(unwrap(await getSecondFactorStatus(db))).toMatchObject({
      steppedUp: true,
      recent: true,
    });
    unwrap(await renameSecondFactor(db, enrollment.factorId, "Work phone"));
    expect(unwrap(await listSecondFactors(db))).toMatchObject([
      { id: enrollment.factorId, type: "totp", label: "Work phone", verified: true },
    ]);

    // A new sign-in owes the second factor until it passes.
    const again = newClient();
    const signedIn = await again.auth.signInWithPassword({ email, password });
    expect(signedIn.error).toBeNull();
    expect(needsSecondFactor(unwrap(await getAssurance(again)))).toBe(true);
    expect(unwrap(await getSecondFactorStatus(again))).toMatchObject({
      steppedUp: false,
      recent: false,
    });
    expect(await removeSecondFactor(again, enrollment.factorId)).toMatchObject({
      ok: false,
      error: { rule: "step_up_required" },
    });
    // A code from the next 30-second window, so the one just used is not replayed.
    unwrap(
      await verifyTotp(again, enrollment.factorId, totp(enrollment.secret, Date.now() + 30_000)),
    );
    expect(needsSecondFactor(unwrap(await getAssurance(again)))).toBe(false);
    unwrap(await removeSecondFactor(again, enrollment.factorId));
    expect(unwrap(await listSecondFactors(again))).toEqual([]);
  }, 30_000);

  it("enrolls a security key as a second factor and verifies it again", async () => {
    const { db } = await signUp();
    const key = new SoftAuthenticator(origin);
    const enrollment = unwrap(await startSecurityKeyEnrollment(db, "Desk key", rp));
    expect(enrollment.ceremony.kind).toBe("create");
    if (enrollment.ceremony.kind !== "create") return;
    unwrap(
      await verifySecurityKey(db, {
        factorId: enrollment.factorId,
        challengeId: enrollment.challengeId,
        kind: "create",
        credential: key.create(enrollment.ceremony.options),
        rp,
      }),
    );
    expect(unwrap(await getAssurance(db)).current).toBe("aal2");
    const challenge = unwrap(await startSecurityKeyChallenge(db, enrollment.factorId, rp));
    expect(challenge.ceremony.kind).toBe("request");
    if (challenge.ceremony.kind !== "request") return;
    unwrap(
      await verifySecurityKey(db, {
        factorId: enrollment.factorId,
        challengeId: challenge.challengeId,
        kind: "request",
        credential: key.get(challenge.ceremony.options),
        rp,
      }),
    );
    expect(unwrap(await getSecondFactorStatus(db))).toMatchObject({
      steppedUp: true,
      recent: true,
    });
  }, 30_000);

  it("registers a passkey, signs in with it and removes it", async () => {
    const { db } = await signUp();
    const authenticator = new SoftAuthenticator(origin);
    const registration = unwrap(await startPasskeyRegistration(db));
    const passkey = unwrap(
      await finishPasskeyRegistration(
        db,
        registration.challengeId,
        authenticator.create(registration.options),
        "Laptop",
      ),
    );
    unwrap(await renamePasskey(db, passkey.id, "Work laptop"));
    expect(unwrap(await listPasskeys(db))).toMatchObject([
      { id: passkey.id, label: "Work laptop" },
    ]);

    const visitor = newClient();
    const signIn = unwrap(await startPasskeySignIn(visitor));
    unwrap(
      await finishPasskeySignIn(visitor, signIn.challengeId, authenticator.get(signIn.options)),
    );
    // A passkey is a first factor: the session is aal1.
    expect(unwrap(await getAssurance(visitor)).current).toBe("aal1");
    unwrap(await removePasskey(visitor, passkey.id));
    expect(unwrap(await listPasskeys(visitor))).toEqual([]);
  }, 30_000);
});
