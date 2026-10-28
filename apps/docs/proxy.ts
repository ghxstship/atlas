import { NextResponse, type NextRequest } from "next/server";
import {
  BRAND_COOKIE,
  BRAND_MAX_AGE,
  encodeBrand,
  parseTenantHosts,
  resolveTenant,
  type DocsBrand,
  type DocsTenant,
} from "@/lib/brand.ts";
import { fetchDocsBrand } from "@/lib/brand-lookup.ts";
import { LOCALES, negotiate } from "@/lib/i18n.ts";

function hasLocale(pathname: string): boolean {
  return (LOCALES as readonly string[]).includes(pathname.split("/")[1] ?? "");
}

/**
 * An org's docs brand, or null when it has none or the lookup is not configured (SUPABASE_URL and
 * SUPABASE_ANON_KEY unset, as in a local build). A failed lookup also answers null: the docs are
 * public, and the platform brand is never another org's identity.
 */
async function brandFor(slug: string): Promise<DocsBrand | null> {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const anonKey = process.env["SUPABASE_ANON_KEY"];
  if (!supabaseUrl || !anonKey) return null;
  try {
    return await fetchDocsBrand(slug, { supabaseUrl, anonKey });
  } catch (error) {
    console.error("Docs brand lookup failed.", { slug, error: String(error) });
    return null;
  }
}

/** Serves an org's docs in its brand (A138, ADR 0066), or the platform docs when it has none. */
async function tenantResponse(request: NextRequest, tenant: DocsTenant): Promise<NextResponse> {
  const brand = await brandFor(tenant.slug);
  const url = request.nextUrl.clone();
  if (brand === null) {
    if (tenant.via === "path") {
      url.pathname = tenant.rest;
      return NextResponse.redirect(url, 307);
    }
    const response = platformResponse(request);
    response.cookies.delete(BRAND_COOKIE);
    return response;
  }
  if (!hasLocale(tenant.rest)) {
    const locale = negotiate(request.headers.get("accept-language"));
    url.pathname = `${tenant.base}/${locale}${tenant.rest === "/" ? "" : tenant.rest}`;
    return NextResponse.redirect(url, 307);
  }
  url.pathname = tenant.rest;
  const response = tenant.via === "path" ? NextResponse.rewrite(url) : NextResponse.next();
  response.cookies.set(BRAND_COOKIE, encodeBrand(brand, tenant.base), {
    path: tenant.base || "/",
    maxAge: BRAND_MAX_AGE,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

/**
 * Every page lives under a locale prefix. A path without one is redirected to the visitor's
 * best locale from Accept-Language, so links without a locale keep working.
 */
function platformResponse(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (hasLocale(pathname)) return NextResponse.next();
  const locale = negotiate(request.headers.get("accept-language"));
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  url.search = search;
  return NextResponse.redirect(url, 307);
}

/**
 * An org's docs (its mapped host, or /o/<org-slug>/… on the docs host) are served in its brand;
 * everything else is the platform docs.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const tenant = resolveTenant(
    request.headers.get("host"),
    request.nextUrl.pathname,
    parseTenantHosts(process.env["XOS_DOCS_TENANT_HOSTS"]),
  );
  return tenant === null ? platformResponse(request) : tenantResponse(request, tenant);
}

export const config = {
  matcher: ["/((?!_next/|openapi\\.json$|favicon\\.ico$).*)"],
};
