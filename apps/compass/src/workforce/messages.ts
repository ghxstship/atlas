/** What a Workforce action tells the person when the server refuses it or it fails. */
import type { DataError, Result } from "@xos/data/result";
import type { ActionResult } from "@xos/workforce-native";
import i18next from "i18next";

/** A refusal in the person's language when the catalog names its rule, else the server's sentence. */
export function actionMessage(error: DataError, t: (key: string) => string): string {
  if (error.kind === "refusal") {
    const key = `workforce.refusals.${error.rule}`;
    return i18next.exists(key) ? t(key) : error.message;
  }
  if (error.kind === "not-found") return t("workforce.compass.common.notFound");
  if (error.kind === "conflict") return t("workforce.compass.common.conflict");
  if (error.kind === "invalid") return t("workforce.compass.common.invalid");
  return t("workforce.compass.common.unexpected");
}

export function toAction(result: Result<unknown>, t: (key: string) => string): ActionResult {
  return result.ok ? { ok: true } : { ok: false, message: actionMessage(result.error, t) };
}
