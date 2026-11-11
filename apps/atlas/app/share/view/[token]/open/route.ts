import { liveLinkOpenHandlers } from "@/lib/live-links/open-route";

/** Opens a saved view live link with its access code (P1, ADR 0130); see lib/live-links/open-route.ts. */
export const dynamic = "force-dynamic";

const handlers = liveLinkOpenHandlers("View");

export async function GET(request: Request, context: RouteContext<"/share/view/[token]/open">) {
  return handlers.GET(request, context);
}

export async function POST(request: Request, context: RouteContext<"/share/view/[token]/open">) {
  return handlers.POST(request, context);
}
