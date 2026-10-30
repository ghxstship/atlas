import {
  badgePhotoUrl,
  CREDENTIAL_PHOTO_NOTICE_VERSION,
  myCredentialPhotos,
} from "@xos/data/credential-photos";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { PageTitle, RegionError } from "@/components/page/page";
import { BadgePhotoUpload } from "@/components/profile/badge-photo-upload";
import { Card, Tag } from "@/components/ui";
import {
  chooseProfilePhotoAction,
  removeBadgePhotoAction,
  uploadBadgePhotoAction,
} from "@/lib/actions/profile";
import { formatDate } from "@/lib/format";
import { requireNode } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.profile.badgePhotos") };
}

/**
 * Badge photos (P5, G-144): one card per org that holds a live credential for the person, with the photo its badge
 * prints, who sees it and how to take it back, and the person's choices: upload or take a photo (cropped by hand),
 * use their profile photo, or remove it, which also withdraws their consent. An org's photo request links here.
 */
export default async function BadgePhotosPage() {
  const ctx = await requireNode("profile.badge-photos");
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);
  const photos = await myCredentialPhotos(ctx.db);
  const title = t("gateway.badgePhotos.title");
  if (!photos.ok) {
    return (
      <>
        <PageTitle title={title} />
        <RegionError />
      </>
    );
  }
  const thumbnails = await Promise.all(
    photos.data.map((p) => (p.photoPath ? badgePhotoUrl(ctx.db, p.photoPath) : null)),
  );
  const labels = {
    upload: t("gateway.badgePhotos.upload"),
    choose: t("gateway.badgePhotos.choose"),
    cropLabel: t("gateway.badgePhotos.cropLabel"),
    cropHelp: t("gateway.badgePhotos.cropHelp"),
    save: t("gateway.badgePhotos.save"),
    cancel: t("gateway.badgePhotos.cancel"),
    saved: t("gateway.badgePhotos.saved"),
    fileType: t("gateway.badgePhotos.fileType"),
    fileSize: t("gateway.badgePhotos.fileSize"),
  };
  return (
    <>
      <PageTitle title={title} lead={t("gateway.badgePhotos.lead")} />
      {photos.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("gateway.badgePhotos.none")}</p>
      ) : (
        <div className="flex flex-col gap-16">
          {photos.data.map((p, i) => {
            const thumbnail = thumbnails[i];
            return (
              <Card
                key={p.orgId}
                title={p.orgName}
                meta={<Tag>{t(`gateway.badgePhotos.states.${p.state}`)}</Tag>}
              >
                <div className="flex flex-wrap items-start gap-16">
                  {thumbnail ? (
                    // A 60-second signed link to the person's own photo; next/image would cache it past its expiry.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbnail}
                      alt={t("gateway.badgePhotos.thumbnailAlt", { org: p.orgName })}
                      width={90}
                      height={120}
                      className="h-120 w-90 rounded-md border border-border object-cover"
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col gap-8">
                    <p className="m-0 text-text-13">
                      <span className="sr-only">{t("gateway.badgePhotos.stateLabel")}: </span>
                      {t(`gateway.badgePhotos.stateHelp.${p.state}`)}
                      {p.providedAt
                        ? ` ${t("gateway.badgePhotos.providedOn", { date: formatDate(locale, p.providedAt) })}.`
                        : null}
                    </p>
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("gateway.badgePhotos.notice", { org: p.orgName })}{" "}
                      {t("gateway.badgePhotos.noticeVersion", {
                        version: CREDENTIAL_PHOTO_NOTICE_VERSION,
                      })}
                    </p>
                    <BadgePhotoUpload
                      action={uploadBadgePhotoAction.bind(null, p.orgId)}
                      labels={labels}
                    />
                    <span className="flex flex-wrap gap-8">
                      {p.hasProfilePhoto ? (
                        <ActionButton
                          action={chooseProfilePhotoAction.bind(null, p.orgId)}
                          label={t("gateway.badgePhotos.useProfile")}
                          done={labels.saved}
                        />
                      ) : null}
                      {p.source ? (
                        <ActionButton
                          action={removeBadgePhotoAction.bind(null, p.orgId)}
                          label={t("gateway.badgePhotos.remove")}
                          variant="ghost"
                          done={t("gateway.badgePhotos.removed")}
                        />
                      ) : null}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
