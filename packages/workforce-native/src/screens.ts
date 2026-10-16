/**
 * The Compass screens of the Workforce Suite and the Atlas sitemap node each one mirrors, so the
 * Compass follow-up can mount them on matching routes. `crew` marks the screens every member uses;
 * the rest are for the site operations roles that hold the matching capability.
 */
export const workforceScreens = [
  { name: "FeedScreen", node: "knowledge.feed", crew: true },
  { name: "SurveyScreen", node: "knowledge.feed", crew: true },
  { name: "ConversationsScreen", node: "people.chat", crew: true },
  { name: "ChatThreadScreen", node: "people.chat", crew: true },
  { name: "DirectoryScreen", node: "people.chat", crew: true },
  { name: "EventsScreen", node: "schedule.events", crew: true },
  { name: "FormFillScreen", node: "knowledge.forms", crew: true },
  { name: "TrainingScreen", node: "knowledge.training", crew: true },
  { name: "HandbookScreen", node: "knowledge.handbook", crew: true },
  { name: "RecognitionScreen", node: "people.recognition", crew: true },
  { name: "HelpDeskScreen", node: "people.help-desk", crew: true },
  { name: "OccupancyCounterScreen", node: "site-ops.occupancy", crew: false },
  { name: "WeatherScreen", node: "site-ops.weather", crew: false },
  { name: "DoorCheckInScreen", node: "site-ops.guest-check-in", crew: false },
  { name: "LostFoundScreen", node: "site-ops.lost-and-found", crew: false },
] as const;

export type WorkforceScreenName = (typeof workforceScreens)[number]["name"];
