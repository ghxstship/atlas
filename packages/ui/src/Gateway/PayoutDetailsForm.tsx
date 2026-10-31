import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { Card } from "../Surface/Surface.tsx";
import { Input, Select } from "../Forms/Forms.tsx";
import { type PayoutDetailsFormProps } from "./Gateway.types.ts";

/** Bank details in a secure form; after saving only the last four digits are shown. */
export function PayoutDetailsForm({ rail, onFile, onSave }: PayoutDetailsFormProps): ReactElement {
  const t = useT();
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [type, setType] = useState("checking");
  return (
    <Card
      title={t("payout.title")}
      meta={rail}
      footer={
        <Button variant="primary" icon="Lock" onClick={() => onSave?.({ routing, account, type })}>
          {t("payout.save")}
        </Button>
      }
    >
      {onFile ? (
        <div className={cx(chipClass, "h-control-lg self-start")}>
          <Icon name="Landmark" size={14} />
          <span>{onFile.bank}</span>
          <span className="font-mono">{t("payout.masked", { last4: onFile.last4 })}</span>
        </div>
      ) : null}
      <Input
        label={t("payout.routing")}
        inputMode="numeric"
        autoComplete="off"
        placeholder={t("payout.routingHint")}
        value={routing}
        onChange={(e) => setRouting(e.target.value)}
      />
      <Input
        label={t("payout.account")}
        inputMode="numeric"
        autoComplete="off"
        type="password"
        help={t("payout.accountHelp")}
        value={account}
        onChange={(e) => setAccount(e.target.value)}
      />
      <Select
        label={t("payout.type")}
        value="checking"
        options={[
          { value: "checking", label: t("payout.checking") },
          { value: "savings", label: t("payout.savings") },
        ]}
        onChange={(e) => setType(e.target.value)}
      />
    </Card>
  );
}
