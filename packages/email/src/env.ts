import { Resend } from "resend";
import { z } from "zod";
import {
  GuardedTransport,
  MailpitTransport,
  RecordingTransport,
  ResendTransport,
  type EmailTransport,
  type ResendClient,
} from "./transport.ts";

/**
 * Email environment, validated once at start-up. Without XOS_EMAIL_TRANSPORT=resend nothing is sent:
 * messages are recorded. With Resend, recipients are limited to XOS_EMAIL_ALLOWLIST unless
 * XOS_EMAIL_DELIVER_TO_ANY=true, which only the production deployment sets (Section 19.8).
 * XOS_EMAIL_TRANSPORT=mailpit delivers into the local stack's inbox at XOS_EMAIL_MAILPIT_URL, for
 * development and end-to-end tests; it refuses any host that is not local.
 */
export const emailEnvSchema = z
  .object({
    XOS_EMAIL_TRANSPORT: z.enum(["record", "resend", "mailpit"]).default("record"),
    XOS_EMAIL_MAILPIT_URL: z.url({ protocol: /^https?$/ }).optional(),
    RESEND_API_KEY: z
      .string()
      .regex(/^re_[A-Za-z0-9_]{8,}$/, "RESEND_API_KEY must be a Resend API key")
      .optional(),
    XOS_EMAIL_FROM: z.string().min(3).default("XOS <notifications@xos.localhost>"),
    XOS_EMAIL_ALLOWLIST: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    XOS_EMAIL_DELIVER_TO_ANY: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((env, ctx) => {
    if (env.XOS_EMAIL_TRANSPORT === "resend" && env.RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required for the resend transport",
      });
    }
    if (env.XOS_EMAIL_TRANSPORT === "mailpit" && env.XOS_EMAIL_MAILPIT_URL === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["XOS_EMAIL_MAILPIT_URL"],
        message: "XOS_EMAIL_MAILPIT_URL is required for the mailpit transport",
      });
    }
  });

export type EmailEnv = z.output<typeof emailEnvSchema>;

/** Parses the email environment, throwing a readable error that names each bad variable. */
export function readEmailEnv(source: Readonly<Record<string, string | undefined>>): EmailEnv {
  const parsed = emailEnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid email environment: ${problems}`);
  }
  return parsed.data;
}

/**
 * Builds the transport the environment asks for. The Resend client is created only for the resend
 * transport, and is always wrapped by the recipient guard.
 */
export function createTransport(
  env: EmailEnv,
  makeClient: (apiKey: string) => ResendClient = (apiKey) => new Resend(apiKey),
): EmailTransport {
  if (env.XOS_EMAIL_TRANSPORT === "mailpit" && env.XOS_EMAIL_MAILPIT_URL !== undefined)
    return new MailpitTransport(env.XOS_EMAIL_MAILPIT_URL);
  if (env.XOS_EMAIL_TRANSPORT !== "resend" || env.RESEND_API_KEY === undefined)
    return new RecordingTransport();
  return new GuardedTransport(new ResendTransport(makeClient(env.RESEND_API_KEY)), {
    allowed: env.XOS_EMAIL_ALLOWLIST,
    deliverToAny: env.XOS_EMAIL_DELIVER_TO_ANY,
  });
}
