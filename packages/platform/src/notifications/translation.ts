import { z } from "zod";

/**
 * Chat message translation (Section 4.9 Chat, finding A65-012). The workforce chat stores the language a
 * message was written in (app.chat_messages.language); this is the seam that translates it into the
 * reader's language: a provider port, a Google Cloud Translation adapter, and the use case that checks
 * the org setting and caches each translation (app.chat_message_translations).
 *
 * Off by default twice over: the platform runs the `off` provider unless XOS_MESSAGE_TRANSLATION=google,
 * and an org translates only when it turns on `communication.message_translation`. Like the catalog
 * pipeline (ADR 0037), the Google adapter calls Cloud Translation v3 over fetch and authenticates with
 * short-lived access tokens: Application Default Credentials or Workload Identity Federation, never a
 * stored key. Tests pass fake transports; nothing here calls the network unless a caller wires `fetch`.
 */

export interface TranslationRequest {
  readonly text: string;
  /** BCP 47 language of the reader, for example es-US. */
  readonly targetLanguage: string;
  /** Language the author wrote in, when known. */
  readonly sourceLanguage?: string | null;
}

export interface TranslationResult {
  readonly text: string;
  /** Language the provider detected, when the source was not given. */
  readonly detectedSourceLanguage: string | null;
}

/** The provider port. */
export interface MessageTranslator {
  /** Provider name stored with each translation, or `off`. */
  readonly provider: string;
  readonly enabled: boolean;
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

/** Raised when translation is off or the provider failed. */
export class TranslationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationUnavailableError";
  }
}

/** The default provider: translation is off and nothing leaves the platform. */
export const translationOff: MessageTranslator = {
  provider: "off",
  enabled: false,
  translate() {
    return Promise.reject(new TranslationUnavailableError("Message translation is off."));
  },
};

// Access tokens without stored keys ---------------------------------------------------------------------

/** Returns a short-lived Google OAuth access token; `refresh` asks for a new one after a 401. */
export type AccessTokenSource = (refresh?: boolean) => Promise<string>;

/**
 * A token minted outside the process: GOOGLE_OAUTH_ACCESS_TOKEN set by google-github-actions/auth, or
 * by `gcloud auth application-default print-access-token` on a developer machine (ADR 0037).
 */
export function staticAccessToken(token: string): AccessTokenSource {
  return () => Promise.resolve(token);
}

export interface WorkloadIdentityOptions {
  /** Workload identity provider audience: //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>. */
  readonly audience: string;
  /** Service account to impersonate, which holds roles/cloudtranslate.user. */
  readonly serviceAccountEmail: string;
  /** The platform's own OIDC token for this request (for example Vercel's OIDC token). */
  readonly subjectToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

const stsReply = z.object({ access_token: z.string().min(1) });
const iamReply = z.object({ accessToken: z.string().min(1), expireTime: z.string() });

/**
 * Workload Identity Federation: exchanges the platform's OIDC token at Google STS, then impersonates the
 * translation service account for a one-hour access token, cached until five minutes before it expires.
 */
export function workloadIdentityToken(options: WorkloadIdentityOptions): AccessTokenSource {
  const doFetch = options.fetch ?? fetch;
  let cached: { token: string; expires: number } | null = null;
  return async (refresh = false) => {
    if (!refresh && cached && cached.expires - Date.now() > 5 * 60 * 1000) return cached.token;
    const sts = await doFetch("https://sts.googleapis.com/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: options.audience,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectToken: await options.subjectToken(),
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      }),
    });
    if (!sts.ok)
      throw new TranslationUnavailableError(`Google STS refused the token (${sts.status}).`);
    const federated = stsReply.parse(await sts.json()).access_token;
    const iam = await doFetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(options.serviceAccountEmail)}:generateAccessToken`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${federated}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: ["https://www.googleapis.com/auth/cloud-platform"],
          lifetime: "3600s",
        }),
      },
    );
    if (!iam.ok)
      throw new TranslationUnavailableError(
        `Service account impersonation failed (${iam.status}).`,
      );
    const reply = iamReply.parse(await iam.json());
    cached = { token: reply.accessToken, expires: Date.parse(reply.expireTime) };
    return reply.accessToken;
  };
}

// Google Cloud Translation ---------------------------------------------------------------------------------

export const GOOGLE_TRANSLATE_HOST = "https://translation.googleapis.com/v3";

export interface GoogleTranslatorOptions {
  /** Google Cloud project billed through x-goog-user-project, the same project as ADR 0037. */
  readonly project: string;
  /** Location; NMT runs in `global` and covers every chat language. */
  readonly location?: string;
  /** Model under the location; general/nmt by default. */
  readonly model?: string;
  readonly token: AccessTokenSource;
  readonly fetch?: typeof fetch;
}

const translateReply = z.object({
  translations: z
    .array(z.object({ translatedText: z.string(), detectedLanguageCode: z.string().optional() }))
    .min(1),
});

/** Google's code for a BCP 47 tag: es-US becomes es for NMT, zh-TW and pt-BR keep their region. */
export function googleLanguage(tag: string): string {
  const [language, region] = tag.split("-");
  const keepsRegion = new Set(["zh-TW", "zh-CN", "pt-BR", "pt-PT", "fr-CA"]);
  return region !== undefined && keepsRegion.has(`${language}-${region}`) ? tag : (language ?? tag);
}

/** Cloud Translation v3 translateText as plain text, with the access token and the billing project. */
export function googleMessageTranslator(options: GoogleTranslatorOptions): MessageTranslator {
  const doFetch = options.fetch ?? fetch;
  const location = options.location ?? "global";
  const parent = `projects/${options.project}/locations/${location}`;
  const model = `${parent}/models/${options.model ?? "general/nmt"}`;
  return {
    provider: "google",
    enabled: true,
    async translate(request) {
      const body = JSON.stringify({
        contents: [request.text],
        mimeType: "text/plain",
        targetLanguageCode: googleLanguage(request.targetLanguage),
        ...(request.sourceLanguage
          ? { sourceLanguageCode: googleLanguage(request.sourceLanguage) }
          : {}),
        model,
        labels: { tool: "xos-chat" },
      });
      const call = async (refresh: boolean) =>
        doFetch(`${GOOGLE_TRANSLATE_HOST}/${parent}:translateText`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await options.token(refresh)}`,
            "x-goog-user-project": options.project,
            "Content-Type": "application/json; charset=utf-8",
          },
          body,
        });
      let response = await call(false);
      // An expired token gets one fresh token and one more try.
      if (response.status === 401) response = await call(true);
      if (!response.ok)
        throw new TranslationUnavailableError(`Cloud Translation answered ${response.status}.`);
      const first = translateReply.parse(await response.json()).translations[0];
      return {
        text: first?.translatedText ?? "",
        detectedSourceLanguage: first?.detectedLanguageCode ?? null,
      };
    },
  };
}

export const translationEnvSchema = z.object({
  XOS_MESSAGE_TRANSLATION: z.enum(["off", "google"]).default("off"),
  GOOGLE_CLOUD_PROJECT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
    .optional(),
  GOOGLE_TRANSLATE_LOCATION: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("global"),
  GOOGLE_OAUTH_ACCESS_TOKEN: z.string().min(1).optional(),
  GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: z.string().startsWith("//iam.googleapis.com/").optional(),
  GOOGLE_TRANSLATE_SERVICE_ACCOUNT: z.email().optional(),
});
export type TranslationEnv = z.output<typeof translationEnvSchema>;

/**
 * The translator the environment asks for. `off` unless XOS_MESSAGE_TRANSLATION=google with a project
 * and a way to get tokens: GOOGLE_OAUTH_ACCESS_TOKEN, or the Workload Identity audience and service
 * account with the platform's OIDC token.
 */
export function createMessageTranslator(
  source: Readonly<Record<string, string | undefined>>,
  options: { subjectToken?: () => Promise<string>; fetch?: typeof fetch } = {},
): MessageTranslator {
  const parsed = translationEnvSchema.safeParse(source);
  if (!parsed.success || parsed.data.XOS_MESSAGE_TRANSLATION !== "google") return translationOff;
  const env = parsed.data;
  if (env.GOOGLE_CLOUD_PROJECT === undefined) return translationOff;
  let token: AccessTokenSource | null = null;
  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) token = staticAccessToken(env.GOOGLE_OAUTH_ACCESS_TOKEN);
  else if (
    env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE &&
    env.GOOGLE_TRANSLATE_SERVICE_ACCOUNT &&
    options.subjectToken
  )
    token = workloadIdentityToken({
      audience: env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE,
      serviceAccountEmail: env.GOOGLE_TRANSLATE_SERVICE_ACCOUNT,
      subjectToken: options.subjectToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  if (token === null) return translationOff;
  return googleMessageTranslator({
    project: env.GOOGLE_CLOUD_PROJECT,
    location: env.GOOGLE_TRANSLATE_LOCATION,
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

// The use case ---------------------------------------------------------------------------------------------------

export interface ChatMessageToTranslate {
  readonly orgId: string;
  readonly body: string | null;
  readonly language: string | null;
}

/** What chat translation needs from the database (service role, after the caller's own read check). */
export interface TranslationStore {
  message(messageId: string): Promise<ChatMessageToTranslate | null>;
  /** The org's communication.message_translation setting. */
  enabled(orgId: string): Promise<boolean>;
  cached(messageId: string, targetLanguage: string): Promise<string | null>;
  save(
    messageId: string,
    targetLanguage: string,
    text: string,
    sourceLanguage: string | null,
    provider: string,
  ): Promise<void>;
}

export type ChatTranslation =
  | { readonly kind: "translated"; readonly text: string; readonly cached: boolean }
  | { readonly kind: "same-language" }
  | { readonly kind: "off" }
  | { readonly kind: "unavailable"; readonly reason: string };

function baseLanguage(tag: string | null): string | null {
  return tag === null ? null : (tag.split("-")[0] ?? null);
}

/**
 * Translates one chat message into the reader's language: nothing when the org or the platform has
 * translation off or the message is already in that language, the cached translation when one exists,
 * otherwise the provider's, which is cached for the next reader.
 */
export async function translateChatMessage(
  store: TranslationStore,
  translator: MessageTranslator,
  input: { readonly messageId: string; readonly targetLanguage: string },
): Promise<ChatTranslation> {
  const message = await store.message(input.messageId);
  if (message === null || message.body === null)
    return { kind: "unavailable", reason: "No text to translate." };
  if (!translator.enabled || !(await store.enabled(message.orgId))) return { kind: "off" };
  if (baseLanguage(message.language) === baseLanguage(input.targetLanguage))
    return { kind: "same-language" };
  const cached = await store.cached(input.messageId, input.targetLanguage);
  if (cached !== null) return { kind: "translated", text: cached, cached: true };
  try {
    const result = await translator.translate({
      text: message.body,
      targetLanguage: input.targetLanguage,
      sourceLanguage: message.language,
    });
    await store.save(
      input.messageId,
      input.targetLanguage,
      result.text,
      message.language ?? result.detectedSourceLanguage,
      translator.provider,
    );
    return { kind: "translated", text: result.text, cached: false };
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
