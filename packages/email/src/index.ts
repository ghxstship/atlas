export {
  createTransport,
  emailEnvSchema,
  lazyResendClient,
  readEmailEnv,
  type EmailEnv,
} from "./env.ts";
export {
  emailCatalog,
  formatMessage,
  hasMessage,
  translator,
  type MessageArgs,
  type MessageValue,
  type Translate,
} from "./messages.ts";
export { isTemplateCode, renderEmail, type RenderedEmail, type RenderOptions } from "./render.ts";
export { TEMPLATE_CODES } from "./templates/codes.ts";
export { sendEmail, type SendRequest } from "./send.ts";
export type { Sender } from "./templates/layout.tsx";
export {
  templates,
  type KindItem,
  type TemplateCode,
  type TemplateProps,
} from "./templates/index.tsx";
export {
  EmailSendError,
  GuardedTransport,
  MailpitTransport,
  RecipientRefusedError,
  RecordingTransport,
  ResendTransport,
  recipientAllowed,
  type EmailTransport,
  type OutgoingEmail,
  type RecipientPolicy,
  type ResendClient,
  type SendResult,
} from "./transport.ts";
