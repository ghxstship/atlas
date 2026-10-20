import type { Metadata } from "next";
import {
  ShellHelpArticle,
  shellHelpMetadata,
  shellHelpParams,
} from "@/components/shell-help-article.tsx";

export const dynamicParams = false;

export function generateStaticParams() {
  return shellHelpParams("compass");
}

type Params = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return shellHelpMetadata("compass", await params);
}

/** A Compass help article (Section 11.16), the same one Compass's Help shows. */
export default async function CompassHelpArticlePage({ params }: Params) {
  return <ShellHelpArticle shell="compass" {...await params} />;
}
