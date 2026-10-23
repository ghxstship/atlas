import { parse } from "yaml";
import { z } from "zod";
import {
  NOTIFICATION_CHANNELS,
  copyKeys,
  type KindDefinition,
  type KindEmission,
  type NotificationKindRegistry,
} from "./model.ts";

const CODE = /^[a-z][a-z_]*$/;
const KIND = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
/** A repository-relative file, optionally followed by `#symbol`. */
const EMITTER = /^(apps|packages|supabase)\/[A-Za-z0-9_./()[\]-]+\.(ts|tsx|sql)(#[A-Za-z0-9_.]+)?$/;
const TEST = /^(apps|packages|supabase)\/[A-Za-z0-9_./()[\]-]+\.(test\.tsx?|test\.sql|spec\.ts)$/;

const channelSchema = z.strictObject({
  code: z.enum(NOTIFICATION_CHANNELS),
  default: z.boolean(),
});

const emailTemplateSchema = z.strictObject({
  code: z.string().regex(CODE),
  transactional: z.boolean(),
  description: z.string().trim().min(1).max(300),
});

const categorySchema = z.strictObject({
  code: z.string().regex(CODE),
  urgent: z.boolean(),
  order: z.int().min(1).max(32767),
});

const kindSchema = z.strictObject({
  kind: z.string().regex(KIND),
  category: z.string().regex(CODE),
  email_template: z.string().regex(CODE).optional(),
  push_category: z.string().regex(CODE).optional(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1).optional(),
  // true: always reaches the person at once; { starts_within_hours }: only while the subject (for
  // example a shift, through the startsAt argument) starts within that many hours.
  bypasses_quiet_hours: z
    .union([z.literal(true), z.strictObject({ starts_within_hours: z.int().min(1).max(72) })])
    .optional(),
  // Where private.notify sends the kind and the test that observes it, or why nothing sends it yet (RRR-125).
  emitted_by: z
    .array(z.strictObject({ emitter: z.string().regex(EMITTER), test: z.string().regex(TEST) }))
    .min(1)
    .optional(),
  deferred: z
    .strictObject({
      reason: z.string().trim().min(20).max(400),
      decision: z.string().trim().min(5).max(200),
    })
    .optional(),
});

const registrySchema = z.strictObject({
  version: z.literal(1),
  channels: z.array(channelSchema).length(NOTIFICATION_CHANNELS.length),
  email_templates: z.array(emailTemplateSchema).min(1),
  categories: z.array(categorySchema).min(1),
  kinds: z.array(kindSchema).min(1),
});

/** Raised when the notification kind registry is malformed or breaks a registry rule. */
export class NotificationRegistryError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Notification kind registry is invalid:\n  ${issues.join("\n  ")}`);
    this.name = "NotificationRegistryError";
    this.issues = issues;
  }
}

function duplicates(values: readonly (string | number)[]): (string | number)[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

/**
 * Parses and checks the registry text: unique codes, kinds and orders, every channel declared once,
 * every kind in a declared category with a declared email template, and every kind either sent by a named
 * emitter or deferred with its reason. The default email template of a kind is `notification`, and a kind
 * reaches every channel unless it names its own.
 */
export function parseNotificationRegistry(text: string): NotificationKindRegistry {
  return parseRegistryText(text).registry;
}

/** Each kind's emitters, or the recorded reason nothing sends it yet, keyed by kind in registry order. */
export function parseNotificationEmission(text: string): Map<string, KindEmission> {
  return parseRegistryText(text).emission;
}

function parseRegistryText(text: string): {
  registry: NotificationKindRegistry;
  emission: Map<string, KindEmission>;
} {
  const parsed = registrySchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new NotificationRegistryError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const raw = parsed.data;
  const issues: string[] = [];
  const check = (label: string, values: readonly (string | number)[]) => {
    for (const d of new Set(duplicates(values))) issues.push(`${label} ${d} is declared twice`);
  };
  check(
    "channel",
    raw.channels.map((c) => c.code),
  );
  check(
    "email template",
    raw.email_templates.map((t) => t.code),
  );
  check(
    "category",
    raw.categories.map((c) => c.code),
  );
  check(
    "category order",
    raw.categories.map((c) => c.order),
  );
  check(
    "kind",
    raw.kinds.map((k) => k.kind),
  );

  const categories = new Set(raw.categories.map((c) => c.code));
  const templates = new Set(raw.email_templates.map((t) => t.code));
  if (!templates.has("notification")) issues.push("the notification email template is required");
  const used = new Set<string>();
  const emission = new Map<string, KindEmission>();
  const kinds: KindDefinition[] = raw.kinds.map((k) => {
    if (k.emitted_by !== undefined && k.deferred !== undefined)
      issues.push(`kind ${k.kind} is both emitted and deferred; keep one`);
    else if (k.emitted_by === undefined && k.deferred === undefined)
      issues.push(
        `kind ${k.kind} names no emitter: add emitted_by (where private.notify sends it and its test) or a deferred reason`,
      );
    emission.set(
      k.kind,
      k.deferred !== undefined
        ? { status: "deferred", deferral: { ...k.deferred } }
        : { status: "emitted", by: (k.emitted_by ?? []).map((e) => ({ ...e })) },
    );
    const emailTemplate = k.email_template ?? "notification";
    if (!categories.has(k.category)) issues.push(`kind ${k.kind}: unknown category ${k.category}`);
    if (!templates.has(emailTemplate))
      issues.push(`kind ${k.kind}: unknown email template ${emailTemplate}`);
    const channels = k.channels ?? NOTIFICATION_CHANNELS;
    check(`kind ${k.kind} channel`, channels);
    if (!channels.includes("In App"))
      issues.push(`kind ${k.kind}: every kind is shown in the app (In App)`);
    if (k.push_category !== undefined && !channels.includes("Push"))
      issues.push(`kind ${k.kind}: a push category needs the Push channel`);
    if (k.bypasses_quiet_hours !== undefined && !channels.some((c) => c === "SMS" || c === "Push"))
      issues.push(
        `kind ${k.kind}: only SMS and Push keep quiet hours, so a bypass needs one of them`,
      );
    used.add(k.category);
    return {
      kind: k.kind,
      category: k.category,
      emailTemplate,
      pushCategory: k.push_category ?? null,
      quietHoursBypass:
        k.bypasses_quiet_hours === undefined
          ? null
          : {
              startsWithinHours:
                k.bypasses_quiet_hours === true ? null : k.bypasses_quiet_hours.starts_within_hours,
            },
      channels: NOTIFICATION_CHANNELS.filter((c) => channels.includes(c)),
      copy: copyKeys(k.kind),
    };
  });
  for (const c of raw.categories) {
    if (!used.has(c.code)) issues.push(`category ${c.code} has no kind`);
  }
  if (issues.length > 0) throw new NotificationRegistryError(issues);

  const registry: NotificationKindRegistry = {
    version: raw.version,
    channels: NOTIFICATION_CHANNELS.map((code) => ({
      code,
      enabledByDefault: raw.channels.find((c) => c.code === code)?.default ?? false,
    })),
    emailTemplates: raw.email_templates.map((t) => ({
      code: t.code,
      transactional: t.transactional,
      description: t.description,
    })),
    categories: [...raw.categories]
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ code: c.code, urgent: c.urgent, order: c.order })),
    kinds,
  };
  return { registry, emission };
}
