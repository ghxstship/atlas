import { useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Card } from "../Surface/Surface.tsx";
import { Checkbox, Textarea } from "../Forms/Forms.tsx";
import { type FeedbackWidgetProps } from "./Help.types.ts";

/** Feedback with a privacy note; only what the person chooses is sent. */
export function FeedbackWidget({
  onSend,
  onCancel,
  screenshotField,
  context,
  thanks,
}: FeedbackWidgetProps): ReactElement {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState(false);
  const send = () => {
    const result = onSend?.({ text, screenshot });
    if (!(result instanceof Promise)) {
      setSent(true);
      return;
    }
    setSending(true);
    setFailed(false);
    void result.then(
      (ok) => {
        setSending(false);
        setSent(ok);
        setFailed(!ok);
      },
      () => {
        setSending(false);
        setFailed(true);
      },
    );
  };
  return (
    <Card
      title={t("feedback.title")}
      footer={
        sent ? (
          <span role="status" className="flex items-center gap-6">
            <span className="text-success">
              <Icon name="CircleCheck" />
            </span>
            {thanks ?? t("feedback.thanks")}
          </span>
        ) : (
          <>
            <Button variant="ghost" onClick={onCancel}>
              {t("action.cancel")}
            </Button>
            <Button variant="primary" disabled={!text.trim() || sending} onClick={send}>
              {t("action.send")}
            </Button>
          </>
        )
      }
    >
      <Textarea
        label={t("feedback.question")}
        placeholder={t("feedback.hint")}
        width="100%"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {screenshotField ?? (
        <Checkbox
          label={t("feedback.screenshot")}
          checked={screenshot}
          onChange={(e) => setScreenshot(e.target.checked)}
        />
      )}
      <span className="text-text-12 text-text-secondary">{t("feedback.privacy")}</span>
      {context ? <div className="text-text-12 text-text-secondary">{context}</div> : null}
      {failed ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t("feedback.failed")}
        </span>
      ) : null}
    </Card>
  );
}
