"use client";

import { Button } from "@xos/ui";
import { useState } from "react";
import { useAiFeature } from "@/components/aurora/ai-features";
import { useCopy } from "@/components/collection-kit/use-copy";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

const panel = onDemand(() => import("./needs-suggest-panel"));

/**
 * Suggest categories on a need with no class or element (B11, G-106): Aurora chooses only among candidates the server
 * found, and the person confirms. Shown only while mapping is on; the panel loads on the click.
 */
export function SuggestCategoryButton({
  org,
  needId,
  description,
}: {
  org: string;
  needId: string;
  description: string;
}) {
  const t = useCopy("procurement.needs");
  const on = useAiFeature("mapping");
  const [wanted, setWanted] = useState(false);
  const loaded = useOnDemand(panel, wanted);
  if (!on) return null;
  return wanted && loaded ? (
    <loaded.SuggestCategoryPanel org={org} needId={needId} description={description} />
  ) : (
    <div>
      <Button variant="secondary" size="sm" onClick={() => setWanted(true)}>
        {t("suggest.open")}
      </Button>
    </div>
  );
}
