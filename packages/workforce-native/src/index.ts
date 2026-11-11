/**
 * @xos/workforce-native: the Workforce Suite screens for Compass (Section 4.9), drawn with
 * @xos/ui-native and typed by @xos/data's workforce repositories. Each screen takes translated
 * labels (i18n namespace "workforce"), the data and actions; Compass mounts them on its routes and
 * wires the actions to @xos/data. `workforceScreens` lists them for the mounting follow-up.
 */
export {
  ContentActionsButton,
  defined,
  useActionRunner,
  WorkforceFrame,
  type Action,
  type ActionResult,
  type ContentActions,
  type ContentActionTarget,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";
export {
  FeedScreen,
  type FeedScreenLabels,
  type FeedScreenProps,
  type ReactionCode,
} from "./feed.tsx";
export {
  ConversationsScreen,
  ChatThreadScreen,
  type ConversationsScreenLabels,
  type ConversationsScreenProps,
  type ChatThreadScreenLabels,
  type ChatThreadScreenProps,
} from "./chat.tsx";
export {
  DirectoryScreen,
  type DirectoryScreenLabels,
  type DirectoryScreenProps,
} from "./directory.tsx";
export { EventsScreen, type EventsScreenLabels, type EventsScreenProps } from "./events.tsx";
export {
  FormFillScreen,
  type FormFillScreenLabels,
  type FormFillScreenProps,
} from "./form-fill.tsx";
export {
  TrainingScreen,
  type MyCourse,
  type TrainingScreenLabels,
  type TrainingScreenProps,
} from "./training.tsx";
export {
  HandbookScreen,
  type HandbookScreenLabels,
  type HandbookScreenProps,
} from "./handbook.tsx";
export { SurveyScreen, type SurveyScreenLabels, type SurveyScreenProps } from "./survey.tsx";
export {
  RecognitionScreen,
  type RecognitionScreenLabels,
  type RecognitionScreenProps,
} from "./recognition.tsx";
export {
  HelpDeskScreen,
  type HelpDeskScreenLabels,
  type HelpDeskScreenProps,
} from "./help-desk.tsx";
export {
  OccupancyCounterScreen,
  occupancyLevel,
  type OccupancyCounterScreenLabels,
  type OccupancyCounterScreenProps,
} from "./occupancy.tsx";
export { WeatherScreen, type WeatherScreenLabels, type WeatherScreenProps } from "./weather.tsx";
export {
  DoorCheckInScreen,
  type DoorCheckInScreenLabels,
  type DoorCheckInScreenProps,
} from "./door.tsx";
export {
  LostFoundScreen,
  type LostItemDraft,
  type LostFoundScreenLabels,
  type LostFoundScreenProps,
} from "./lost-found.tsx";
export { workforceScreens, type WorkforceScreenName } from "./screens.ts";
