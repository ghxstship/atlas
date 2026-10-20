/**
 * Google Cloud Translation API v3 over REST, authenticated with Application Default Credentials.
 *
 * The access token comes from GOOGLE_OAUTH_ACCESS_TOKEN when set (GitHub Actions, where
 * google-github-actions/auth mints one through Workload Identity Federation), and otherwise from
 * `gcloud auth application-default print-access-token` (locally, after
 * `gcloud auth application-default login`). No key file and no API key is read or needed.
 */
import { execFileSync } from "node:child_process";

export interface TranslateBatch {
  /** Masked HTML segments. */
  readonly contents: readonly string[];
  /** Google target language code. */
  readonly target: string;
  /** Whether the request uses the glossary. */
  readonly glossary: boolean;
}

export interface Transport {
  translate(batch: TranslateBatch): Promise<string[]>;
}

export type TokenSource = (refresh?: boolean) => Promise<string>;

export interface Environment {
  readonly [name: string]: string | undefined;
}

export function requireEnv(env: Environment, name: string, example: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new Error(
      `Set ${name} (for example ${example}). See infra/runbooks/production.md, Machine translation.`,
    );
  return value;
}

/** Application Default Credentials, as an access token source. */
export function adcTokenSource(
  env: Environment,
  run: (cmd: string, args: string[]) => string = defaultRun,
): TokenSource {
  let cached: { token: string; at: number } | null = null;
  return async (refresh = false) => {
    const given = env["GOOGLE_OAUTH_ACCESS_TOKEN"]?.trim();
    if (given) return given;
    if (!refresh && cached && Date.now() - cached.at < 40 * 60 * 1000) return cached.token;
    let token: string;
    try {
      token = run("gcloud", ["auth", "application-default", "print-access-token"]).trim();
    } catch (error) {
      throw new Error(
        `Could not get Application Default Credentials (${error instanceof Error ? error.message : String(error)}). Install the gcloud CLI and run \`gcloud auth application-default login\`.`,
        { cause: error },
      );
    }
    cached = { token, at: Date.now() };
    return token;
  };
}

function defaultRun(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface GoogleOptions {
  readonly project: string;
  readonly location: string;
  /** Model id under the location, for example general/translation-llm or general/nmt. */
  readonly model: string;
  readonly sourceLanguage: string;
  readonly glossaryId: string;
  readonly contextualGlossary: boolean;
  readonly token: TokenSource;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attempts?: number;
}

export const TRANSLATE_HOST = "https://translation.googleapis.com/v3";

export class GoogleError extends Error {
  override readonly name = "GoogleError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls the Google API with the ADC token, retrying rate limits and server errors. */
export async function googleFetch(
  url: string,
  init: { method: string; body?: string; contentType?: string },
  options: Pick<GoogleOptions, "project" | "token" | "fetch" | "sleep" | "attempts">,
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 5;
  let refresh = false;
  for (let attempt = 1; ; attempt++) {
    const token = await options.token(refresh);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-goog-user-project": options.project,
    };
    if (init.body !== undefined)
      headers["content-type"] = init.contentType ?? "application/json; charset=utf-8";
    const response = await doFetch(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (response.ok) {
      const text = await response.text();
      return text === "" ? {} : (JSON.parse(text) as unknown);
    }
    const detail = await response.text();
    if (response.status === 401 && !refresh) {
      refresh = true;
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= attempts) {
      throw new GoogleError(
        response.status,
        `${init.method} ${url} failed with ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

interface TranslateResponse {
  translations?: Array<{ translatedText?: string }>;
  glossaryTranslations?: Array<{ translatedText?: string }>;
}

/** translateText on projects/{project}/locations/{location}, with HTML content and the glossary. */
export function googleTransport(options: GoogleOptions): Transport {
  const parent = `projects/${options.project}/locations/${options.location}`;
  return {
    async translate(batch) {
      const body = {
        contents: batch.contents,
        mimeType: "text/html",
        sourceLanguageCode: options.sourceLanguage,
        targetLanguageCode: batch.target,
        model: `${parent}/models/${options.model}`,
        labels: { tool: "xos-i18n" },
        ...(batch.glossary
          ? {
              glossaryConfig: {
                glossary: `${parent}/glossaries/${options.glossaryId}`,
                ignoreCase: false,
                ...(options.contextualGlossary ? { contextualTranslationEnabled: true } : {}),
              },
            }
          : {}),
      };
      const reply = (await googleFetch(
        `${TRANSLATE_HOST}/${parent}:translateText`,
        { method: "POST", body: JSON.stringify(body) },
        options,
      )) as TranslateResponse;
      const list =
        batch.glossary && reply.glossaryTranslations
          ? reply.glossaryTranslations
          : reply.translations;
      if (!list || list.length !== batch.contents.length) {
        throw new GoogleError(
          200,
          `translateText returned ${list?.length ?? 0} translations for ${batch.contents.length} segments`,
        );
      }
      return list.map((t) => t.translatedText ?? "");
    },
  };
}
