import { SafetyHeader, SafetyTiles } from "@/components/safety/landing/safety-landing";
import { requireNode } from "@/lib/shell/require-node";
import { getTranslate } from "@/lib/shell/translate";

/** Safety (A09 landing): one tile per Safety page the viewer may open. */
export default async function Page({ params }: PageProps<"/[org]/safety">) {
  const ctx = await requireNode("safety", await params);
  const t = await getTranslate();
  return (
    <div className="flex flex-col gap-16">
      <SafetyHeader t={t} />
      <p className="m-0 max-w-layout-reading text-text-14 text-text-secondary">
        {t("permits.landing.intro")}
      </p>
      <SafetyTiles ctx={ctx} t={t} />
    </div>
  );
}
