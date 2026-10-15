import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PARAM_TYPES } from "@xos/ia";
import { SignTokenFlow } from "@/components/tokens/token-flows";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("gateway.tokens.sign.title"), robots: { index: false, follow: false } };
}

/**
 * An agreement signing link (Section 4.4.6, journey 9; delegated from Atlas). The access code
 * opens the document, the signer types their name, and the signature is final: a signed
 * document is never revoked or edited (A28b 0769).
 */
export default async function AgreementSigningPage({ params }: PageProps<"/sign/[token]">) {
  const { token } = await params;
  if (!PARAM_TYPES.token.test(token)) notFound();
  return <SignTokenFlow token={token} />;
}
