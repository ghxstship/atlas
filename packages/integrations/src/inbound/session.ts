/**
 * Short-lived sessions for chat requests (ADR 0024 left the "chat token minter" without an owner; A83). A slash
 * command, a Teams message or a Slack unfurl reads records as the person linked to the chat user, never as the
 * service role: the Edge Function mints an HS256 JWT for that auth user, valid for one minute, and calls the
 * database with it, so row level security decides what the reply may show. Web Crypto only, so it runs in Deno
 * and in Vitest. The signing key is the project's JWT secret (XOS_API_JWT_SIGNING_KEY), never in code or tests.
 */

export const CHAT_SESSION_SECONDS = 60;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** An HS256 JWT acting as `userId` for CHAT_SESSION_SECONDS, marked as a chat session in `amr`. */
export async function mintChatSession(
  userId: string,
  signingKey: string,
  issuer: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (signingKey.length < 32) throw new Error("The JWT signing key is too short.");
  const head = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: issuer,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iat: nowSeconds,
    exp: nowSeconds + CHAT_SESSION_SECONDS,
    is_anonymous: false,
    amr: [{ method: "xos_chat", timestamp: nowSeconds }],
  })}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(head));
  return `${head}.${base64url(new Uint8Array(signature))}`;
}
