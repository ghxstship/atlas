/**
 * The message for an auth form state error key: refusals from invites, everything else from errors. A plain module,
 * not "use client", so the invitation page (a server component) and the client auth forms both call it; a function
 * exported from a client module is only a client reference on the server, and calling it there fails the page.
 */
export type AuthTranslate = (key: string, values?: Record<string, string>) => string;

export function errorMessage(
  t: AuthTranslate,
  key: string,
  values?: Readonly<Record<string, string>>,
): string {
  return key.startsWith("invite.")
    ? t(`invite.refused.${key.slice("invite.".length)}`)
    : t(`errors.${key}`, values ? { ...values } : undefined);
}
