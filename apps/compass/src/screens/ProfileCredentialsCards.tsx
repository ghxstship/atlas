import { downloadUrl } from "@xos/data/attachments";
import type { XosClient } from "@xos/data";
import { isInternal } from "@xos/sync";
import * as Linking from "expo-linking";
import type { TFunction } from "i18next";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { certificationsUrl, documentsUrl } from "../domain/access";
import { enumKey } from "../domain/external";
import {
  byExpiry,
  expiryCallout,
  expiryStanding,
  fileVersion,
  todayFor,
  toCertification,
  toDocument,
  type ExpiryCallout,
  type ExpiryStanding,
  type ProfileCertification,
  type ProfileDocument,
} from "../domain/profileCredentials";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { Button, Card, InlineAlert, ListRow, Skeleton, Tag, Text } from "../ui";

/**
 * The certifications and documents on the Compass Profile (Section 4.3 item 13, A109). Both lists are the person's own
 * rows (api_external.my_profile_certifications and my_profile_documents, 2080), downloaded to the device with the rest
 * of their work, so they read offline. Each card calls out what expires within the reminder job's thresholds (30, 7 and
 * 1 days, 1463). A document with a file opens it through a short-lived signed URL while online. Editing stays where the
 * person keeps them: their Gateway profile, or Atlas for an internal member.
 */

/** An expiry date with its year ("Mar 1, 2028"): the same day everywhere, never shifted by the phone's zone. */
function formatExpiry(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
}

/** The passport's issuing country by name, or its code where the device has no region names. */
function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function standingTag(standing: ExpiryStanding, t: TFunction): ReactElement | null {
  if (standing.kind === "expired")
    return <Tag tone="danger" label={t("compass.profile.expired")} />;
  if (standing.kind !== "expiring") return null;
  const label =
    standing.daysLeft === 0
      ? t("compass.profile.expiresToday")
      : standing.daysLeft === 1
        ? t("compass.profile.expiresTomorrow")
        : t("compass.profile.expiresInDays", { count: standing.daysLeft });
  return (
    <Tag
      tone={standing.threshold === 30 ? "neutral" : standing.threshold === 7 ? "warning" : "danger"}
      label={label}
    />
  );
}

function Callout({
  callout,
  testID,
}: {
  readonly callout: ExpiryCallout;
  readonly testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const when = (days: number) =>
    days === 0
      ? t("compass.profile.whenToday")
      : days === 1
        ? t("compass.profile.whenTomorrow")
        : t("compass.profile.whenInDays", { count: days });
  return (
    <InlineAlert
      testID={testID}
      tone={callout.tone}
      title={t(`compass.profile.expiring${callout.threshold}`)}
      message={callout.items
        .map((item) =>
          t("compass.profile.expiringItem", { title: item.title, when: when(item.daysLeft) }),
        )
        .join("\n")}
    />
  );
}

function documentTitle(d: ProfileDocument, t: TFunction): string {
  if (d.type === "Passport") return t("compass.profile.passport");
  if (d.type === "Insurance Certificate")
    return t("compass.profile.insuranceTitle", { coverage: d.title ?? "" });
  return d.title ?? "";
}

export function ProfileCredentialsCards(): ReactElement | null {
  const { t, i18n } = useTranslation();
  const { client, config, network, resolved, personZone } = useCompass();
  const certRows = useRows("profile_certifications", undefined, { allOrgs: true });
  const docRows = useRows("profile_documents", undefined, { allOrgs: true });
  const [notice, setNotice] = useState<string | null>(null);
  const locale = i18n.language;
  const certifications = useMemo(
    () =>
      byExpiry(
        certRows.rows.flatMap((r) => toCertification(r) ?? []),
        (c) => c.expiresOn,
        (c) => c.name,
      ),
    [certRows.rows],
  );
  const documents = useMemo(
    () =>
      byExpiry(
        docRows.rows.flatMap((r) => toDocument(r) ?? []),
        (d) => d.expiresOn,
        (d) => d.title ?? d.type,
      ),
    [docRows.rows],
  );
  const identity = resolved?.identity;
  if (!identity) return null;
  const internal = isInternal(identity.audience);
  const certCallout = expiryCallout(
    certifications.map((c) => ({
      id: c.id,
      title: c.name,
      expiresOn: c.expiresOn,
      timeZone: c.timeZone,
    })),
    personZone,
  );
  const docCallout = expiryCallout(
    documents.map((d) => ({
      id: d.id,
      title: documentTitle(d, t),
      expiresOn: d.expiresOn,
      timeZone: d.timeZone,
    })),
    personZone,
  );

  const certificationRow = (c: ProfileCertification) => {
    const standing = expiryStanding(c.expiresOn, todayFor(c.timeZone, personZone));
    const facts = [
      c.issuingBody,
      c.verified
        ? c.verifiedBy
          ? t("compass.profile.verifiedBy", { org: c.verifiedBy })
          : t("compass.profile.verified")
        : t("compass.profile.selfReported"),
      c.expiresOn
        ? t("compass.profile.expiresOn", { date: formatExpiry(c.expiresOn, locale) })
        : t("compass.profile.noExpiry"),
    ].filter((f) => f !== "");
    return (
      <ListRow
        key={c.id}
        testID={`profile-certification-${c.id}`}
        icon="file-check"
        title={c.name}
        subtitle={facts.join(" · ")}
        trailing={
          standingTag(standing, t) ?? (
            <Tag
              tone={c.verified ? "success" : "neutral"}
              label={t(c.verified ? "compass.profile.verified" : "compass.profile.selfReported")}
            />
          )
        }
      />
    );
  };

  const open = async (d: ProfileDocument) => {
    if (!d.file) return;
    if (!network.isConnected) {
      setNotice(t("compass.profile.openOffline"));
      return;
    }
    const url = await downloadUrl(client as unknown as XosClient, fileVersion(d.file));
    if (!url.ok || !/^https?:\/\//.test(url.data)) {
      setNotice(t("compass.profile.openFailed"));
      return;
    }
    setNotice(null);
    await Linking.openURL(url.data);
  };

  const documentRow = (d: ProfileDocument) => {
    const standing = expiryStanding(d.expiresOn, todayFor(d.timeZone, personZone));
    const facts =
      d.type === "Passport"
        ? [
            d.issuer
              ? t("compass.profile.issuedBy", { country: countryName(d.issuer, locale) })
              : "",
          ]
        : d.type === "Insurance Certificate"
          ? [d.issuer ?? "", d.orgName ?? ""]
          : [
              d.kind ? t(`gateway.enums.engagementDocumentKind.${enumKey(d.kind)}`) : "",
              d.orgName ?? "",
              d.state ? t(`gateway.enums.engagementDocumentState.${enumKey(d.state)}`) : "",
            ];
    const expiry = d.expiresOn
      ? t("compass.profile.expiresOn", { date: formatExpiry(d.expiresOn, locale) })
      : "";
    const tag = standingTag(standing, t);
    const file = d.file;
    return (
      <ListRow
        key={d.id}
        testID={`profile-document-${d.id}`}
        icon={d.type === "Passport" ? "plane" : "file-text"}
        title={documentTitle(d, t)}
        subtitle={[...facts, expiry].filter((f) => f !== "").join(" · ")}
        {...(tag ? { trailing: tag } : {})}
        {...(file ? { onPress: () => void open(d) } : {})}
      />
    );
  };

  const loading = certRows.loading || docRows.loading;
  return (
    <>
      <Card
        title={t("compass.profile.certificationsTitle")}
        testID="profile-certifications"
        footer={
          <Button
            testID="profile-certifications-edit"
            variant="ghost"
            icon="external-link"
            label={t(internal ? "compass.profile.editInAtlas" : "compass.profile.editInGateway")}
            onPress={() => void Linking.openURL(certificationsUrl(identity.audience, config))}
          />
        }
      >
        {loading ? (
          <Skeleton lines={2} />
        ) : certifications.length === 0 ? (
          <Text tone="tertiary">{t("compass.profile.certificationsEmpty")}</Text>
        ) : (
          <>
            {certCallout ? (
              <Callout callout={certCallout} testID="profile-certifications-expiring" />
            ) : null}
            {certifications.map(certificationRow)}
          </>
        )}
      </Card>
      <Card
        title={t("compass.profile.documentsTitle")}
        testID="profile-documents"
        footer={
          <Button
            testID="profile-documents-manage"
            variant="ghost"
            icon="external-link"
            label={t(
              internal ? "compass.profile.manageInAtlas" : "compass.profile.manageInGateway",
            )}
            onPress={() => void Linking.openURL(documentsUrl(identity.audience, config))}
          />
        }
      >
        {loading ? (
          <Skeleton lines={2} />
        ) : documents.length === 0 ? (
          <Text tone="tertiary">{t("compass.profile.documentsEmpty")}</Text>
        ) : (
          <>
            {docCallout ? (
              <Callout callout={docCallout} testID="profile-documents-expiring" />
            ) : null}
            {documents.map(documentRow)}
            {notice ? (
              <Text tone="secondary" testID="profile-documents-notice">
                {notice}
              </Text>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
