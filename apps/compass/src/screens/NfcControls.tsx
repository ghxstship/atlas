/**
 * NFC on the Scan tab (A92): whether this phone can read tags, and the test tag a Maestro build shows
 * instead of the system NFC sheet (src/runtime/nfc.ts). The test tag never renders in any other build.
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { fakeNfc, nfc, type FakeNfcReader, type NfcAvailability } from "../runtime/nfc";
import { Button, Sheet, Text, TextField } from "../ui";

/** The radio's state, read once per screen; null while it is being read. */
export function useNfcAvailability(): NfcAvailability | null {
  const [state, setState] = useState<NfcAvailability | null>(null);
  useEffect(() => {
    let live = true;
    void nfc.availability().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function TestTag({ reader }: { readonly reader: FakeNfcReader }): ReactElement {
  const { t } = useTranslation();
  const pending = useSyncExternalStore(reader.subscribe, reader.getSnapshot);
  const [content, setContent] = useState("");
  return (
    <Sheet
      testID="fake-nfc"
      open={pending !== null}
      title={t("compassNfc.test.title")}
      closeLabel={t("compass.common.close")}
      onClose={() => reader.cancel()}
    >
      <Text tone="secondary">{pending?.alert ?? ""}</Text>
      {pending?.kind === "read" ? (
        <TextField
          testID="fake-nfc-content"
          label={t("compassNfc.test.content")}
          help={t("compassNfc.test.contentHelp")}
          value={content}
          onChangeText={setContent}
          autoComplete="off"
        />
      ) : pending?.kind === "write" ? (
        <Text testID="fake-nfc-writing">
          {t("compassNfc.test.writing", { text: pending.text ?? "" })}
        </Text>
      ) : null}
      <Button
        testID="fake-nfc-present"
        size="lg"
        block
        icon="nfc"
        label={t("compassNfc.test.present")}
        onPress={() => {
          reader.present(content);
          setContent("");
        }}
      />
    </Sheet>
  );
}

/** The on-screen test tag of a Maestro build (EXPO_PUBLIC_XOS_FAKE_NFC=1); nothing elsewhere. */
export function FakeNfcSheet(): ReactElement | null {
  return fakeNfc ? <TestTag reader={fakeNfc} /> : null;
}
