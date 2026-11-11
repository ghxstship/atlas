import type { ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { Stepper } from "../Layout/Layout.tsx";
import { type TemplateWizardProps } from "./Templates.types.ts";

/** Multi-step creation: a stepper, one step per page, Back and Next. */
export function TemplateWizard({
  steps,
  current,
  title,
  children,
  onBack,
  onNext,
  finishLabel,
  nextDisabled = false,
}: TemplateWizardProps): ReactElement {
  const t = useT();
  const last = current >= steps.length - 1;
  return (
    <div
      data-template="wizard"
      className="flex flex-col gap-24 w-full max-w-(--layout-form) mx-auto"
    >
      <Stepper steps={steps} current={current} />
      <section className="flex flex-col gap-16">
        <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
        <p className="m-0 text-text-secondary tabular-nums">
          {t("count.step", { n: current + 1, total: steps.length })}
        </p>
        {children}
      </section>
      <div className="flex justify-between gap-8">
        <Button variant="ghost" icon="ChevronLeft" disabled={current === 0} onClick={onBack}>
          {t("nav.previous")}
        </Button>
        <Button variant="primary" disabled={nextDisabled} onClick={onNext}>
          {last ? (finishLabel ?? t("action.done")) : t("nav.next")}
        </Button>
      </div>
    </div>
  );
}
