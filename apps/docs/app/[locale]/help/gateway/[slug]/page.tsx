import type { Metadata } from "next";
import {
  ShellHelpArticle,
  shellHelpMetadata,
  shellHelpParams,
} from "@/components/shell-help-article.tsx";

export const dynamicParams = false;

export function generateStaticParams() {
  return shellHelpParams("gateway");
}

type Params = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return shellHelpMetadata("gateway", await params);
}

/** A Gateway help article (Section 11.16), the same one Gateway's help panel shows. */
export default async function GatewayHelpArticlePage({ params }: Params) {
  return <ShellHelpArticle shell="gateway" {...await params} />;
}
