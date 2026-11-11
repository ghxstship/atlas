import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Gate } from "../src/screens/common";
import { ShowView } from "../src/screens/ShowView";

export default function ShowScreen(): ReactElement {
  const { t } = useTranslation();
  return (
    <Gate feature="show.live" title={t("compass.show.title")}>
      <ShowView readOnly={false} />
    </Gate>
  );
}
