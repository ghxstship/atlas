/**
 * The notification kind registry model (Section 3.15). `notification-kinds.yaml` declares every channel
 * default, email template, preference category and notification kind once; the database reference rows,
 * the preference matrix and the templates index are generated from it.
 */

/** Channels a notification can reach a person on (app.notification_channel), in matrix order. */
export const NOTIFICATION_CHANNELS = ["In App", "Email", "SMS", "Push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Channels outside the app, each with its own delivery row (app.notification_deliveries). */
export const OUTSIDE_CHANNELS = [
  "Email",
  "SMS",
  "Push",
] as const satisfies readonly NotificationChannel[];
export type OutsideChannel = (typeof OUTSIDE_CHANNELS)[number];

export interface ChannelDefinition {
  readonly code: NotificationChannel;
  /** True when the channel is on for a category nobody chose for. */
  readonly enabledByDefault: boolean;
}

export interface EmailTemplateDefinition {
  readonly code: string;
  /** Transactional email carries no unsubscribe link (CAN-SPAM and CASL). */
  readonly transactional: boolean;
  readonly description: string;
}

export interface CategoryDefinition {
  readonly code: string;
  /** Urgent categories reach the person at once: no quiet hours, no digest. */
  readonly urgent: boolean;
  /** Display order in the preference matrix. */
  readonly order: number;
}

export interface KindDefinition {
  /** Notification kind, subject first: `approval.requested`. */
  readonly kind: string;
  readonly category: string;
  /** React Email template of the Email channel. */
  readonly emailTemplate: string;
  /** Actionable push category Compass registers (ADR 0030), or null for a plain push. */
  readonly pushCategory: string | null;
  /**
   * Whether the kind reaches the person during quiet hours, the default SMS window and their own
   * (ADR 0033 decision 35): null when it waits; `startsWithinHours` null to always bypass, or a number of
   * hours within which the subject must start (its `startsAt` argument), as for a shift change.
   */
  readonly quietHoursBypass: { readonly startsWithinHours: number | null } | null;
  /** Channels the kind can be delivered on. */
  readonly channels: readonly NotificationChannel[];
  /** Catalog keys of the kind's copy in the `email` namespace, used on every channel. */
  readonly copy: { readonly subject: string; readonly body: string };
}

/**
 * One place a kind is created (RRR-125): the migration or module that calls private.notify with it and the test
 * that observes the notification. Paths are relative to the repository root; an emitter may name a symbol after
 * `#`, such as `supabase/migrations/1394_notification_kind_emitters.sql#private.notify_shift_change`.
 */
export interface KindEmitter {
  readonly emitter: string;
  readonly test: string;
}

/** Why nothing sends a kind yet, and the owner decision or work package it waits on. */
export interface KindDeferral {
  readonly reason: string;
  readonly decision: string;
}

/** How a kind reaches people: its emitters, or the recorded reason nothing sends it yet. */
export type KindEmission =
  | { readonly status: "emitted"; readonly by: readonly KindEmitter[] }
  | { readonly status: "deferred"; readonly deferral: KindDeferral };

export interface NotificationKindRegistry {
  readonly version: number;
  readonly channels: readonly ChannelDefinition[];
  readonly emailTemplates: readonly EmailTemplateDefinition[];
  readonly categories: readonly CategoryDefinition[];
  readonly kinds: readonly KindDefinition[];
}

/** Catalog keys (in the `email` namespace) of a kind's subject and body. */
export function copyKeys(kind: string): { subject: string; body: string } {
  return { subject: `kinds.${kind}.subject`, body: `kinds.${kind}.body` };
}

/**
 * The channels the kinds of a category reach, in matrix order (A104). A preference grid offers a switch only for
 * these: a channel no kind of the category is delivered on, such as SMS for opportunities, could never send
 * anything. Empty for a category without kinds.
 */
export function categoryChannels(
  registry: Pick<NotificationKindRegistry, "kinds">,
  category: string,
): NotificationChannel[] {
  const reached = new Set(
    registry.kinds.filter((k) => k.category === category).flatMap((k) => k.channels),
  );
  return NOTIFICATION_CHANNELS.filter((c) => reached.has(c));
}

/** One row of the preference matrix: a category, the kinds it gathers and the channels they reach. */
export interface MatrixRow extends CategoryDefinition {
  readonly kinds: readonly string[];
  readonly channels: readonly NotificationChannel[];
}

/** The preference matrix: categories in display order by channel, with each channel's default. */
export function preferenceMatrix(
  registry: Pick<NotificationKindRegistry, "categories" | "kinds">,
): MatrixRow[] {
  return [...registry.categories]
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      ...c,
      kinds: registry.kinds.filter((k) => k.category === c.code).map((k) => k.kind),
      channels: categoryChannels(registry, c.code),
    }));
}
