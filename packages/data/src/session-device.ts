import { clientAddress, trustedProxyHops } from "./client-address.ts";

/**
 * The device behind a request, as Atlas, Gateway and the API record it for Personal settings, Security (A99, ADR
 * 0055; migration 1561):
 *   - the client address as `clientAddress()` reads it: the entry the trusted proxy appended, counted past
 *     `XOS_TRUSTED_PROXY_HOPS`, never the first X-Forwarded-For entry, which the client writes (A69-003);
 *   - the approximate place, only where the host derived it from that same address itself: on Vercel, which sets
 *     `x-vercel-ip-city`, `x-vercel-ip-country-region` and `x-vercel-ip-country` and drops any a client sent, and only
 *     with no trusted proxy in front of it (otherwise the headers describe the proxy). Elsewhere there is no place and
 *     Security shows the address;
 *   - the user agent, for the device name.
 */

export interface RequestDevice {
  readonly clientAddress: string | null;
  readonly place: string | null;
  readonly userAgent: string | null;
}

function decoded(value: string | null): string | null {
  if (!value) return null;
  try {
    const text = decodeURIComponent(value).trim();
    const control = [...text].some((c) => c.charCodeAt(0) < 32);
    return text === "" || control ? null : text.slice(0, 60);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/** The approximate place from the hosting platform's geolocation headers, or null where they cannot be trusted. */
export function placeFrom(
  headers: { get(name: string): string | null },
  options: { readonly onVercel: boolean; readonly trustedHops: number },
): string | null {
  if (!options.onVercel || options.trustedHops > 0) return null;
  const parts = [
    decoded(headers.get("x-vercel-ip-city")),
    decoded(headers.get("x-vercel-ip-country-region")),
    decoded(headers.get("x-vercel-ip-country")),
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(", ").slice(0, 120);
}

/** The device behind a request, from its headers and the server's environment. */
export function requestDevice(
  headers: { get(name: string): string | null },
  environment: {
    readonly VERCEL?: string | undefined;
    readonly XOS_TRUSTED_PROXY_HOPS?: string | undefined;
  },
): RequestDevice {
  const trustedHops = trustedProxyHops(environment.XOS_TRUSTED_PROXY_HOPS);
  const agent = headers.get("user-agent")?.trim() ?? "";
  return {
    clientAddress: clientAddress(headers, trustedHops),
    place: placeFrom(headers, { onVercel: environment.VERCEL === "1", trustedHops }),
    userAgent: agent === "" ? null : agent.slice(0, 512),
  };
}
