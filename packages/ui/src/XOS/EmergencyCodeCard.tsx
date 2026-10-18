import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { SERVICES } from "./XOS.shared.tsx";
import { type EmergencyCodeCardProps } from "./XOS.types.ts";
import { resolveStep } from "./resolveStep.tsx";

const SWATCH: Record<EmergencyCodeCardProps["swatch"], string> = {
  "ecode-red": cx("bg-ecode-red border-t-ecode-red"),
  "ecode-orange": cx("bg-ecode-orange border-t-ecode-orange"),
  "ecode-yellow": cx("bg-ecode-yellow border-t-ecode-yellow"),
  "ecode-green": cx("bg-ecode-green border-t-ecode-green"),
  "ecode-blue": cx("bg-ecode-blue border-t-ecode-blue"),
  "ecode-purple": cx("bg-ecode-purple border-t-ecode-purple"),
  "ecode-white": cx("bg-ecode-white border-t-ecode-white"),
  "ecode-black": cx("bg-ecode-black border-t-ecode-black"),
  "ecode-pink": cx("bg-ecode-pink border-t-ecode-pink"),
  "ecode-indigo": cx("bg-ecode-indigo border-t-ecode-indigo"),
  "ecode-silver": cx("bg-ecode-silver border-t-ecode-silver"),
  "ecode-grey": cx("bg-ecode-grey border-t-ecode-grey"),
  "ecode-amber": cx("bg-ecode-amber border-t-ecode-amber"),
  "ecode-adam": cx("bg-ecode-adam border-t-ecode-adam"),
};

/**
 * One global emergency code's protocol for one operational domain. The code word is always written;
 * the swatch is for recognition only. Steps name services; the jurisdiction supplies the agencies.
 */
export function EmergencyCodeCard({
  authorities,
  recordKey,
  code,
  name,
  swatch,
  domain,
  steps,
  channel,
}: EmergencyCodeCardProps): ReactElement {
  const t = useT();
  const used = SERVICES.filter((s) => steps.some((step) => step.includes(`{${s}}`)));
  const listed = (authorities ?? [])
    .filter((a) => used.includes(a.service))
    .sort((a, b) => SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service));
  const tone = SWATCH[swatch] ?? SWATCH["ecode-red"];
  return (
    <article
      aria-labelledby={`${recordKey ?? code}-title`}
      className={cx(
        "flex flex-col gap-8 w-(--ui-popover) max-w-full p-16 box-border rounded-card bg-bg-raised",
        "border border-border-subtle border-t-stroke-swatch",
        tone.split(" ")[1],
      )}
    >
      <header className="flex items-center gap-8">
        <span
          aria-hidden="true"
          className={cx(
            "flex-none size-icon-24 rounded-chip ring-(length:--stroke-width-hairline) ring-inset ring-border-control",
            tone.split(" ")[0],
          )}
        />
        <div className="flex flex-col">
          <strong id={`${recordKey ?? code}-title`} className="text-heading-16 font-semibold">
            {code}
          </strong>
          <span>{name}</span>
        </div>
        {recordKey ? (
          <span className="ms-auto font-mono text-text-12 text-text-secondary">{recordKey}</span>
        ) : null}
      </header>
      {domain ? (
        <span className="text-text-12 font-medium text-text-secondary">{domain}</span>
      ) : null}
      <ol className="flex flex-col gap-4 m-0 ps-20">
        {steps.map((step, i) => (
          <li key={i}>{resolveStep(step, authorities, t)}</li>
        ))}
      </ol>
      {listed.length ? (
        <dl
          aria-label={t("ecode.authorities")}
          className="flex flex-col gap-4 m-0 pt-8 border-t border-border-subtle"
        >
          {listed.map((a) => (
            <div key={a.service} className="flex gap-8">
              <dt className="flex-none w-(--ui-props-label) text-text-12 font-medium text-text-secondary">
                {t(`ecode.role.${a.service}`)}
              </dt>
              <dd className="m-0">
                {a.agency}
                {a.contact ? (
                  <span className="text-text-secondary tabular-nums"> · {a.contact}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {channel ? (
        <footer className="flex items-center gap-6 text-text-12 text-text-secondary">
          <Icon name="Radio" size={14} />
          <span>{channel}</span>
        </footer>
      ) : null}
    </article>
  );
}
