"use client";

import type { SupportChannel } from "@xos/data/support";
import { Button, Drawer } from "@xos/ui";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ContactForm } from "@/components/help/contact-form";
import { collectDiagnostics, type CollectedDiagnostics } from "@/components/help/diagnostics";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Settings, Help and support: an admin's way to contact the platform team (Section 11.16). */
export function PlatformContact({
  org,
  platformChannel,
}: {
  org: string;
  platformChannel: SupportChannel | null;
}) {
  const t = useTranslations("support") as unknown as Translate;
  const pathname = usePathname();
  const [diagnostics, setDiagnostics] = useState<CollectedDiagnostics | null>(null);
  return (
    <div className="flex flex-col gap-8">
      <p className="m-0 text-text-secondary">
        {platformChannel
          ? t("org.terms", { terms: t(`channels.${platformChannel}`) })
          : t("org.noPlatform")}
      </p>
      {platformChannel ? (
        <Button
          icon="LifeBuoy"
          className="self-start"
          onClick={() => setDiagnostics(collectDiagnostics(pathname, navigator.userAgent))}
        >
          {t("org.contactPlatform")}
        </Button>
      ) : null}
      {diagnostics ? (
        <Drawer
          title={t("org.contactPlatform")}
          open
          onOpenChange={(open) => {
            if (!open) setDiagnostics(null);
          }}
        >
          <ContactForm
            org={org}
            canContactPlatform
            initialQueue="Platform"
            platformChannel={platformChannel}
            diagnostics={diagnostics}
            onCancel={() => setDiagnostics(null)}
          />
        </Drawer>
      ) : null}
    </div>
  );
}
