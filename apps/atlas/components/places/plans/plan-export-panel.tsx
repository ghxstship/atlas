"use client";

import { Select } from "@xos/ui";
import { DownloadLink } from "@/components/ui";
import { useState } from "react";
import { useCopy } from "../kit/form";

const LAYERS = ["pins", "routes", "barriers", "areas", "labels"] as const;
type Layer = (typeof LAYERS)[number];

/** The export link of a plan's PDF with its choices, as the document route reads them (parseSitePlanExportOptions). */
export function sitePlanExportHref(
  base: string,
  choice: { paper: string; layers: readonly Layer[]; legend: string; pins: boolean },
): string {
  const params = new URLSearchParams();
  if (choice.paper !== "letter") params.set("paper", choice.paper);
  if (choice.layers.length !== LAYERS.length) params.set("layers", choice.layers.join(","));
  if (choice.legend !== "kinds") params.set("legend", choice.legend);
  if (choice.pins) params.set("pins", "1");
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Export a site plan as a tagged PDF (G-19, ADR 0031 amendment B1): paper, the layers drawn on the drawing, the legend
 * and the pin table. Loaded on demand; the link goes to the document route, so the PDF is made on the server as the
 * viewer.
 */
export function PlanExportPanel({ href }: { href: string }) {
  const t = useCopy("places");
  const [paper, setPaper] = useState("letter");
  const [legend, setLegend] = useState("kinds");
  const [pins, setPins] = useState(false);
  const [layers, setLayers] = useState<readonly Layer[]>(LAYERS);
  return (
    <section aria-labelledby="plan-export-heading" className="flex flex-col gap-12">
      <h3 id="plan-export-heading" className="m-0 text-text-14 font-semibold">
        {t("plans.export.title")}
      </h3>
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="export-paper"
          label={t("plans.export.paper")}
          value={paper}
          onChange={(e) => setPaper(e.currentTarget.value)}
          options={[
            { value: "letter", label: t("plans.export.letter") },
            { value: "a4", label: t("plans.export.a4") },
          ]}
        />
        <Select
          id="export-legend"
          label={t("plans.export.legend")}
          value={legend}
          onChange={(e) => setLegend(e.currentTarget.value)}
          options={[
            { value: "kinds", label: t("plans.export.legendKinds") },
            { value: "items", label: t("plans.export.legendItems") },
            { value: "none", label: t("plans.export.legendNone") },
          ]}
        />
      </div>
      <fieldset className="m-0 flex flex-wrap gap-12 border-0 p-0">
        <legend className="mb-4 text-text-13 font-semibold">{t("plans.export.layers")}</legend>
        {LAYERS.map((layer) => (
          <label key={layer} className="flex min-h-24 items-center gap-4 text-text-13">
            <input
              type="checkbox"
              checked={layers.includes(layer)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setLayers((current) =>
                  on ? [...current, layer] : current.filter((l) => l !== layer),
                );
              }}
            />
            {t(`plans.export.layer.${layer}`)}
          </label>
        ))}
        <label className="flex min-h-24 items-center gap-4 text-text-13">
          <input
            type="checkbox"
            checked={pins}
            onChange={(e) => setPins(e.currentTarget.checked)}
          />
          {t("plans.export.pinTable")}
        </label>
      </fieldset>
      <DownloadLink
        href={sitePlanExportHref(href, {
          paper,
          layers: layers.length > 0 ? layers : LAYERS,
          legend,
          pins,
        })}
      >
        {t("plans.export.download")}
      </DownloadLink>
    </section>
  );
}
