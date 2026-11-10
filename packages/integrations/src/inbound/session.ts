/**
 * Short-lived sessions for chat requests (ADR 0024 left the "chat token minter" without an owner; A83). A slash
 * command, a Teams message or a Slack unfurl reads records as the person linked to the chat user, never as the
 * service role: the Edge Function mints a JWT for that auth user, valid for one minute, and calls the database
 * with it, so row level security decides what the reply may show. It is signed by the signer the function is
 * handed, over the project signing key XOS_API_JWT_SIGNING_KEY (@xos/platform's project-token, ADR 0168), which
 * never appears in code or tests.
 */

export const CHAT_SESSION_SECONDS = 60;

/** Signs a token's claims; the caller never sees the key. */
export type TokenSigner = (claims: Record<string, unknown>) => Promise<string>;

/** A JWT acting as `userId` for CHAT_SESSION_SECONDS, marked as a chat session in `amr`. */
export function mintChatSession(
  userId: string,
  sign: TokenSigner,
  issuer: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return sign({
    iss: issuer,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iat: nowSeconds,
    exp: nowSeconds + CHAT_SESSION_SECONDS,
    is_anonymous: false,
    amr: [{ method: "xos_chat", timestamp: nowSeconds }],
  });
}
