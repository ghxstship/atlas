import { getNode } from "@xos/ia";
import { PageHeader } from "@/components/ui";
import { pageCopyKey, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/** A settings section's title from the sitemap and its one-sentence description from the catalog. */
export async function SectionHeader({ node }: { node: string }) {
  const t = await getTranslate();
  return (
    <>
      <PageHeader title={t(getNode(sitemap, node).node.label)} />
      <p className="m-0 text-text-13 text-text-secondary">{t(`${pageCopyKey(node)}.empty`)}</p>
    </>
  );
}
