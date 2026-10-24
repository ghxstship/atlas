import { z } from "zod";
import type { WebPushClient } from "./web-push.ts";

/**
 * The Web Push environment and the client it asks for (A96, ADR 0052), apart from the sender itself so the
 * notification-dispatch Edge Function boots without the encryption and VAPID code: the client loads web-push.ts the
 * first time a run has a browser to push (A85's per-function boot budgets).
 */

export const webPushEnvSchema = z
  .object({
    XOS_WEB_PUSH_TRANSPORT: z.enum(["record", "vapid"]).default("record"),
    VAPID_PUBLIC_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}$/, "an uncompressed P-256 public key, base64url")
      .optional(),
    VAPID_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "a P-256 private key, base64url")
      .optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, "a mailto: or https: contact")
      .optional(),
  })
  .refine(
    (env) =>
      env.XOS_WEB_PUSH_TRANSPORT !== "vapid" ||
      (env.VAPID_PUBLIC_KEY !== undefined &&
        env.VAPID_PRIVATE_KEY !== undefined &&
        env.VAPID_SUBJECT !== undefined),
    {
      message:
        "XOS_WEB_PUSH_TRANSPORT=vapid needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT",
      path: ["VAPID_PUBLIC_KEY"],
    },
  );
export type WebPushEnv = z.output<typeof webPushEnvSchema>;

/** Parses the Web Push environment, naming each bad variable without echoing its value. */
export function readWebPushEnv(source: Readonly<Record<string, string | undefined>>): WebPushEnv {
  const parsed = webPushEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid web push environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * The client the environment asks for: VAPID with XOS_WEB_PUSH_TRANSPORT=vapid, recording otherwise. The sender
 * module loads on the first push, so a run with no browser to push never loads it.
 */
export function createWebPushClient(env: WebPushEnv, fetchImpl?: typeof fetch): WebPushClient {
  const vapid = env.XOS_WEB_PUSH_TRANSPORT === "vapid";
  let client: Promise<WebPushClient> | undefined;
  const load = () =>
    (client ??= import("./web-push.ts").then((m) =>
      vapid
        ? m.vapidWebPushClient({
            keys: {
              publicKey: env.VAPID_PUBLIC_KEY ?? "",
              privateKey: env.VAPID_PRIVATE_KEY ?? "",
              subject: env.VAPID_SUBJECT ?? "",
            },
            ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
          })
        : new m.RecordingWebPushClient(),
    ));
  return {
    name: vapid ? "vapid" : "record",
    async send(device, payload, options) {
      return (await load()).send(device, payload, options);
    },
  };
}
