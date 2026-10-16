/**
 * Webhook testing.
 *
 *   xos webhooks sign   --file body.json (--secret-env NAME | --secret-stdin) [--timestamp T]
 *   xos webhooks verify --file body.json --signature "t=...,v1=..." (--secret-env NAME | --secret-stdin)
 *   xos webhooks send   --url URL --file body.json (--secret-env NAME | --secret-stdin)
 *   xos webhooks events
 *   xos webhooks replay <delivery-id>
 *
 * Secrets come from an environment variable or standard input, never from a flag value.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SIGNATURE_HEADER, signWebhookPayload, verifyWebhookSignature } from "@xos/sdk";
import type { Context } from "../context.ts";
import { UsageError } from "../io.ts";
import { render } from "../output.ts";

const SECRET_OPTIONS = {
  file: { type: "string" },
  "secret-env": { type: "string" },
  "secret-stdin": { type: "boolean", default: false },
} as const;

async function secretFrom(
  ctx: Context,
  values: { "secret-env"?: string | undefined; "secret-stdin"?: boolean | undefined },
): Promise<string> {
  if (values["secret-stdin"]) {
    const secret = (await ctx.io.readStdin()).trim();
    if (!secret) throw new UsageError("Standard input was empty; pipe the signing secret in.");
    return secret;
  }
  const name = values["secret-env"];
  if (!name)
    throw new UsageError("Pass the signing secret with --secret-env NAME or --secret-stdin.");
  const secret = ctx.io.env[name];
  if (!secret) throw new UsageError(`The environment variable ${name} is empty or unset.`);
  return secret;
}

function payloadFrom(file: string | undefined): string {
  if (!file) throw new UsageError("Pass the raw delivery body with --file.");
  return readFileSync(file, "utf8");
}

export async function webhooksCommand(ctx: Context, argv: readonly string[]): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case "sign": {
      const { values } = parseArgs({
        args: rest,
        options: { ...SECRET_OPTIONS, timestamp: { type: "string" } },
      });
      const payload = payloadFrom(values.file);
      const secret = await secretFrom(ctx, values);
      const ts = values.timestamp === undefined ? undefined : Number(values.timestamp);
      if (ts !== undefined && !Number.isInteger(ts))
        throw new UsageError("--timestamp takes Unix seconds.");
      ctx.io.stdout(`${await signWebhookPayload(payload, secret, ts)}\n`);
      return 0;
    }
    case "verify": {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...SECRET_OPTIONS,
          signature: { type: "string" },
          tolerance: { type: "string" },
        },
      });
      if (!values.signature)
        throw new UsageError(`Pass the ${SIGNATURE_HEADER} header value with --signature.`);
      const result = await verifyWebhookSignature({
        payload: payloadFrom(values.file),
        header: values.signature,
        secret: await secretFrom(ctx, values),
        ...(values.tolerance ? { toleranceSeconds: Number(values.tolerance) } : {}),
      });
      render(ctx.io, ctx.format, result);
      return result.valid ? 0 : 1;
    }
    case "send": {
      const { values } = parseArgs({
        args: rest,
        options: { ...SECRET_OPTIONS, url: { type: "string" } },
      });
      if (!values.url) throw new UsageError("Pass your endpoint with --url.");
      const payload = payloadFrom(values.file);
      const signature = await signWebhookPayload(payload, await secretFrom(ctx, values));
      const response = await (ctx.io.fetch ?? fetch)(values.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signature },
        body: payload,
      });
      render(ctx.io, ctx.format, {
        url: values.url,
        status: response.status,
        accepted: response.ok,
      });
      return response.ok ? 0 : 1;
    }
    case "events": {
      const rows = [];
      for await (const event of ctx.client().webhookEventTypes.listAll()) rows.push(event);
      render(ctx.io, ctx.format, rows);
      return 0;
    }
    case "replay": {
      if (!rest[0]) throw new UsageError("Name the delivery: `xos webhooks replay <delivery-id>`.");
      render(ctx.io, ctx.format, (await ctx.client().webhookDeliveries.replay(rest[0])).data);
      return 0;
    }
    default:
      throw new UsageError("Use `xos webhooks sign`, `verify`, `send`, `events` or `replay <id>`.");
  }
}
