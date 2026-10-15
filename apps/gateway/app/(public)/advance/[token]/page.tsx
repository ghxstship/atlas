import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PARAM_TYPES } from "@xos/ia";
import { AdvanceTokenFlow } from "@/components/tokens/token-flows";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.tokens.advance.title"), robots: { index: false, follow: false } };
}

/**
 * An advance form by link (Section 4.4.6, delegated from Atlas: servedBy gateway). It works
 * without an account: the access code opens the packet, each section is answered in place, and
 * the person is then offered an account that claims the answers by verified email.
 */
export default async function AdvanceFormPage({ params }: PageProps<"/advance/[token]">) {
  const { token } = await params;
  if (!PARAM_TYPES.token.test(token)) notFound();
  return <AdvanceTokenFlow token={token} />;
}
