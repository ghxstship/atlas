import { NextResponse, type NextRequest } from "next/server";
import { LOCALES, negotiate } from "@/lib/i18n.ts";

/**
 * Every page lives under a locale prefix. A path without one is redirected to the visitor's
 * best locale from Accept-Language, so links without a locale keep working.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";
  if ((LOCALES as readonly string[]).includes(first)) return NextResponse.next();
  const locale = negotiate(request.headers.get("accept-language"));
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  url.search = search;
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: ["/((?!_next/|openapi\\.json$|favicon\\.ico$).*)"],
};
