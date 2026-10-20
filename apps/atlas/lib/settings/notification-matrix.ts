/**
 * The columns of the notification matrix (app.notification_channel, in order) with the catalog key of
 * each label (`settings.notifications.channels.*`). Shared by the server panels and the client forms.
 */
export const MATRIX_CHANNELS = [
  { channel: "In App", key: "inApp" },
  { channel: "Email", key: "email" },
  { channel: "SMS", key: "sms" },
  { channel: "Push", key: "push" },
] as const;
