/**
 * Where each Workforce screen mounts in Compass. Built from @xos/workforce-native's workforceScreens (each
 * screen and the Atlas sitemap node it mirrors), so a new screen there fails the mounting test until it
 * has a route here. Crew screens are for every member; site operations screens show to people who hold
 * the capability their RPC checks on the current project (0806).
 */
import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import { workforceScreens, type WorkforceScreenName } from "@xos/workforce-native";

export interface WorkforceRoute {
  /** Compass route that mounts the screen. */
  readonly route: string;
  /** Catalog key of the hub row, under workforce.compass.hub.screens. */
  readonly label: string;
  readonly icon: string;
  /** Shown in the hub; screens reached from another screen (a thread, a survey) are not. */
  readonly listed: boolean;
  /** Capability the site operations screen's writes need on the project. */
  readonly capability?: CapabilityCode;
}

export const WORKFORCE_ROUTES: Readonly<Record<WorkforceScreenName, WorkforceRoute>> = {
  FeedScreen: { route: "/workforce/feed", label: "feed", icon: "inbox", listed: true },
  SurveyScreen: { route: "/workforce/surveys", label: "surveys", icon: "list", listed: true },
  ConversationsScreen: { route: "/workforce/chat", label: "chat", icon: "users", listed: true },
  ChatThreadScreen: {
    route: "/workforce/chat/[conversationId]",
    label: "chat",
    icon: "users",
    listed: false,
  },
  DirectoryScreen: {
    route: "/workforce/directory",
    label: "directory",
    icon: "user",
    listed: true,
  },
  EventsScreen: { route: "/workforce/events", label: "events", icon: "calendar", listed: true },
  FormFillScreen: {
    route: "/workforce/forms",
    label: "forms",
    icon: "clipboard-check",
    listed: true,
  },
  TrainingScreen: {
    route: "/workforce/training",
    label: "training",
    icon: "book-open",
    listed: true,
  },
  HandbookScreen: {
    route: "/workforce/handbook",
    label: "handbook",
    icon: "file-text",
    listed: true,
  },
  RecognitionScreen: {
    route: "/workforce/recognition",
    label: "recognition",
    icon: "circle-check",
    listed: true,
  },
  HelpDeskScreen: {
    route: "/workforce/help-desk",
    label: "helpDesk",
    icon: "circle-help",
    listed: true,
  },
  OccupancyCounterScreen: {
    route: "/workforce/occupancy",
    label: "occupancy",
    icon: "users",
    listed: true,
    capability: "safety.incident.write",
  },
  WeatherScreen: {
    route: "/workforce/weather",
    label: "weather",
    icon: "sun",
    listed: true,
    capability: "safety.incident.write",
  },
  DoorCheckInScreen: {
    route: "/workforce/door",
    label: "door",
    icon: "key-round",
    listed: true,
    capability: "credentials.scan.write",
  },
  LostFoundScreen: {
    route: "/workforce/lost-found",
    label: "lostFound",
    icon: "package",
    listed: true,
    capability: "safety.incident.write",
  },
};

export interface HubEntry extends WorkforceRoute {
  readonly name: WorkforceScreenName;
  readonly node: string;
  readonly crew: boolean;
}

/** The hub's rows for a member: crew screens, then the site operations screens they may use. */
export function hubEntries(capabilities: readonly string[]): {
  crew: HubEntry[];
  siteOps: HubEntry[];
} {
  const entries = workforceScreens
    .map((s) => ({ ...WORKFORCE_ROUTES[s.name], name: s.name, node: s.node, crew: s.crew }))
    .filter((e) => e.listed);
  return {
    crew: entries.filter((e) => e.crew),
    siteOps: entries.filter(
      (e) => !e.crew && (e.capability === undefined || capabilities.includes(e.capability)),
    ),
  };
}
