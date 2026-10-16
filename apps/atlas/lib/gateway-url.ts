/**
 * The full Gateway URL of a token flow path such as `/advance/{token}` or `/sign/{token}`
 * (Section 4.4.6), from GATEWAY_SITE_URL. Atlas shows it once to the person who issued the link.
 * Without the variable (a local stack that runs no Gateway) the path alone is shown, which is still
 * the right route on any Gateway origin. Server only: it reads the process environment.
 */
export function gatewayUrl(
  path: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const origin = (source["GATEWAY_SITE_URL"] ?? "").trim().replace(/\/+$/, "");
  return origin.length > 0 ? `${origin}${path.startsWith("/") ? path : `/${path}`}` : path;
}
