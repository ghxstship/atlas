import { requireNode } from "@/components/shell/sitemap-page";
import { ChatSection } from "@/components/workforce/chat";
import { nodeHref } from "@/lib/shell/sitemap";

/** People > Chat (Section 4.9 Chat and Directory). */
export default async function Page({ params, searchParams }: PageProps<"/[org]/people/chat">) {
  const routeParams = await params;
  const ctx = await requireNode("people.chat", routeParams);
  return (
    <ChatSection
      ctx={ctx}
      path={nodeHref("people.chat", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
