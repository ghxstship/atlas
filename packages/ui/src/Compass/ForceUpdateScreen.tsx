import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Phone, blockClass } from "./Compass.shared.tsx";
import { type ForceUpdateScreenProps } from "./Compass.types.ts";

/** Blocks the app below the forced minimum version (Section 5.1) until the person updates. */
export function ForceUpdateScreen({
  frame,
  message,
  version,
  onUpdate,
}: ForceUpdateScreenProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame} tall>
      <div className="flex flex-1 flex-col items-center justify-center gap-12 px-24 py-32 text-center">
        <Icon name="Smartphone" size={28} className="text-text-secondary" />
        <strong className="text-heading-20 font-semibold">{t("update.title")}</strong>
        <p className="m-0 text-text-secondary">{message}</p>
        <span className="font-mono text-mono-12 text-text-secondary">{version}</span>
        <Button variant="primary" size="lg" className={blockClass} onClick={onUpdate}>
          {t("update.action")}
        </Button>
      </div>
    </Phone>
  );
}
