import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NotificationKindRegistry } from "./model.ts";
import { parseNotificationRegistry } from "./parse.ts";

/** Location of the notification kind registry: the package root. */
export const NOTIFICATION_KINDS_YAML_PATH = fileURLToPath(
  new URL("../../notification-kinds.yaml", import.meta.url),
);

/** Reads and checks notification-kinds.yaml (Node only; apps read the generated module). */
export function loadNotificationRegistry(
  path: string = NOTIFICATION_KINDS_YAML_PATH,
): NotificationKindRegistry {
  return parseNotificationRegistry(readFileSync(path, "utf8"));
}
