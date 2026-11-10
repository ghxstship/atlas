// Push and SMS copy loads on first use (loadNotificationCopy); tests that format it directly load it once here.
import { loadNotificationCopy } from "../src/notifications/copy.ts";

await loadNotificationCopy();
