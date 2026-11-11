import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Gate } from "../src/screens/common";
import { ShowView } from "../src/screens/ShowView";

/** The read-only running order for audiences that follow the show (client, crew, artist). */
export default function RunOfShowScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <Gate feature="show.read" title={t("compass.show.runOfShow")}>
      <ShowView readOnly />
    </Gate>
  );
}
