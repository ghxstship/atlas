import type { SensitiveEntryAboutMe } from "@xos/data/sensitive-consent";
import { Button } from "@/components/ui";
import { removeSensitiveEntryAction } from "@/lib/work-details/actions";
import type { Translate } from "@/lib/shell/translate";

const P = "workDetails.consent.about";

/**
 * What someone else entered about the person under an attestation (ADR 0164): who, when and, for a guest list entry,
 * the values. The person removes any of it in one step. Shown only once there is something to show.
 */
export function EnteredForMeSection({
  t,
  entries,
  hidden,
  formatDay,
}: {
  t: Translate;
  entries: readonly SensitiveEntryAboutMe[];
  hidden: Readonly<Record<string, string>>;
  formatDay: (at: string) => string;
}) {
  if (entries.length === 0) return null;
  return (
    <section
      aria-labelledby="work-details-about"
      className="flex max-w-layout-form flex-col gap-12"
    >
      <header className="flex flex-col gap-4">
        <h2 id="work-details-about" className="m-0 text-heading-16 font-semibold">
          {t(`${P}.title`)}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.description`)}</p>
      </header>
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0 text-text-13">
        {entries.map((e) => {
          const category = t(`workDetails.consent.categories.${e.category}`);
          return (
            <li
              key={e.consentId}
              className="flex flex-wrap items-center justify-between gap-8 py-8"
            >
              <span className="flex flex-col gap-2">
                <strong>{category}</strong>
                <span className="text-text-secondary">
                  {e.orgName
                    ? t(`${P}.byOrg`, {
                        name: e.givenByName ?? "",
                        org: e.orgName,
                        date: formatDay(e.givenAt),
                      })
                    : t(`${P}.by`, { name: e.givenByName ?? "", date: formatDay(e.givenAt) })}
                </span>
                {e.guestName ? (
                  <span className="text-text-secondary">
                    {t(`${P}.guest`, { guest: e.guestName })}
                  </span>
                ) : null}
              </span>
              <form action={removeSensitiveEntryAction}>
                {Object.entries(hidden).map(([name, value]) => (
                  <input key={name} type="hidden" name={name} value={value} />
                ))}
                <input type="hidden" name="consentId" value={e.consentId} />
                <Button type="submit" size="sm" variant="ghost">
                  {t(`${P}.removeNamed`, { category })}
                </Button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
