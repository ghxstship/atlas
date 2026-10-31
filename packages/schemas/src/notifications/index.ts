/**
 * The notification kind registry (Section 3.15): `notification-kinds.yaml` is the single source of kinds,
 * the preference matrix and the templates index. Apps and senders read the generated module; the
 * generator and the tests parse the YAML (load.ts, Node only).
 */
import { categoryChannels, type KindDefinition, type NotificationChannel } from "./model.ts";
import { NOTIFICATION_KINDS } from "./registry.generated.ts";

export * from "./model.ts";
export {
  NotificationRegistryError,
  parseNotificationEmission,
  parseNotificationRegistry,
} from "./parse.ts";
export {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNEL_DEFAULTS,
  NOTIFICATION_EMAIL_TEMPLATES,
  NOTIFICATION_KINDS,
  NOTIFICATION_REGISTRY_VERSION,
} from "./registry.generated.ts";
export {
  NOTIFICATION_KIND_DRIFT_TEST,
  NOTIFICATION_KIND_SEED_MIGRATION,
  renderNotificationDriftTest,
  renderNotificationSeedSql,
} from "./sql.ts";
export { NOTIFICATION_REGISTRY_MODULE, renderNotificationRegistryModule } from "./generate.ts";
export { ACTION_PATH, ACTION_TOKEN, isActionToken } from "./action-token.ts";

/** The registry entry of a kind, or undefined for a kind the registry does not declare. */
export function notificationKind(kind: string): KindDefinition | undefined {
  return NOTIFICATION_KINDS.find((k) => k.kind === kind);
}

/**
 * The channels the kinds of a category reach in the registry, in matrix order: the only channels a preference grid
 * offers a switch for (categoryChannels, A104). Empty for a category the registry does not declare.
 */
export function notificationCategoryChannels(category: string): readonly NotificationChannel[] {
  return categoryChannels({ kinds: NOTIFICATION_KINDS }, category);
}
