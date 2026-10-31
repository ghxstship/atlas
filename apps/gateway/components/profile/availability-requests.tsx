import { myAvailabilityRequests } from "@xos/data/crew/availability-polls";
import type { XosClient } from "@xos/data";
import { SimpleForm } from "@/components/forms/simple-form";
import { RegionError, Section } from "@/components/page/page";
import { Card } from "@/components/ui";
import { answerAvailabilityPollAction } from "@/lib/actions/profile";
import { formatDate, formatDateTime } from "@/lib/format";
import type { Translate } from "@/lib/shell/translate";

const KINDS = ["Available", "Tentative", "Unavailable"] as const;

/**
 * Availability requests (P8, ADR 0063): the open availability polls orgs sent the person, each a
 * card with a choice per day. A day the org's notice lock already holds reads as locked. Answering
 * shares those days with that org's planners, as the card says; the answers go on the calendar the
 * person keeps for that org. The availability.requested notification links here
 * (/profile#availability-requests). Shows nothing when no poll is open.
 */
export async function AvailabilityRequests({
  db,
  t,
  locale,
}: {
  db: XosClient;
  t: Translate;
  locale: string;
}) {
  const result = await myAvailabilityRequests(db);
  if (!result.ok) return <RegionError />;
  if (result.data.length === 0) return null;
  return (
    <Section title={t("gateway.profile.availabilityRequests.title")} id="availability-requests">
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.profile.availabilityRequests.shared")}
      </p>
      {result.data.map((r) => {
        const open = r.days.filter((d) => !d.locked);
        return (
          <Card key={r.pollId} title={r.title} meta={`${r.orgName} · ${r.projectName}`}>
            <div className="flex flex-col gap-8">
              {r.message ? <p className="m-0 text-text-13">{r.message}</p> : null}
              {r.closesAt ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("gateway.profile.availabilityRequests.closes", {
                    when: formatDateTime(locale, r.closesAt),
                  })}
                </p>
              ) : null}
              {r.days
                .filter((d) => d.locked)
                .map((d) => (
                  <p key={d.day} className="m-0 text-text-13">
                    {t("gateway.profile.availabilityRequests.locked", {
                      day: formatDate(locale, d.day),
                      answer: t(
                        `gateway.profile.availabilityRequests.kinds.${d.answer ?? "Unstated"}`,
                      ),
                    })}
                  </p>
                ))}
              {open.length > 0 ? (
                <SimpleForm
                  id={`availability-request-${r.pollId}`}
                  action={answerAvailabilityPollAction}
                  label={t("gateway.profile.availabilityRequests.formLabel", { title: r.title })}
                  errorsNamespace="gateway.profile.errors"
                  submitLabel={t("gateway.profile.availabilityRequests.save")}
                  doneLabel={t("gateway.profile.availabilityRequests.saved")}
                  hidden={{ pollId: r.pollId }}
                  fields={open.map((d) => ({
                    name: `day:${d.day}`,
                    label: formatDate(locale, d.day),
                    kind: "select" as const,
                    defaultValue: d.answer ?? "",
                    options: [
                      { value: "", label: t("gateway.profile.availabilityRequests.choose") },
                      ...KINDS.map((k) => ({
                        value: k,
                        label: t(`gateway.profile.availabilityRequests.kinds.${k}`),
                      })),
                    ],
                  }))}
                />
              ) : null}
            </div>
          </Card>
        );
      })}
    </Section>
  );
}
