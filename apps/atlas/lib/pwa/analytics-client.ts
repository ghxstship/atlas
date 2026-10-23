import { routeTemplate } from "@xos/infra/observability/browser";
import { productAnalytics, type ProductAnalytics } from "@xos/ui/pwa/analytics";
import { CLIENT_ERROR_ROUTES } from "@/lib/client-error-routes";

/**
 * Atlas's product analytics in the browser (Section 11.14, A96). Loaded only when the consent seam said yes
 * (lib/privacy/product-analytics.ts); paths become the same route templates browser error reports use.
 */
export function startAnalytics(): ProductAnalytics {
  return productAnalytics({
    endpoint: "/api/product-events",
    template: (path) => routeTemplate(path, CLIENT_ERROR_ROUTES),
  });
}
