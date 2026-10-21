/**
 * Voice notes on an incident report (SIM-003, journey 54; Section 11.13 Incidents). Hold the microphone to
 * record, release to stop; each note plays back and can be deleted before the report is sent. The files stay
 * on the device until the queued report uploads them to field-media, so recording works offline.
 * VoiceOver users double-tap to start and double-tap again to stop, since a hold is not available to them.
 */
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import {
  formatNoteLength,
  keepVoiceNote,
  VOICE_START_GRACE_MS,
  VOICE_STOP_TIMEOUT_MS,
  voiceStopOutcome,
  type VoiceNote,
} from "../domain/incidents";
import { useVoiceRecorder } from "../runtime/voiceRecorder";
import { Icon, IconButton, InlineAlert, Text, useTheme } from "../ui";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves true once the check passes, false when it has not within ms. */
async function becomes(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** Resolves true when the promise settles in time, false when the time runs out first. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function VoiceNotes({
  notes,
  onChange,
}: {
  readonly notes: readonly VoiceNote[];
  readonly onChange: (notes: VoiceNote[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { recorder, state: recording } = useVoiceRecorder();
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The start in flight, so a release that comes before the microphone is ready waits for it instead of
  // leaving a recording running.
  const starting$ = useRef<Promise<boolean> | null>(null);

  const begin = async (): Promise<boolean> => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setProblem(t("compass.incidents.voice.permissionDenied"));
      return false;
    }
    player.pause();
    setPlayingId(null);
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    return true;
  };

  const start = () => {
    if (recorder.isRecording || starting$.current) return;
    setProblem(null);
    setStarting(true);
    starting$.current = begin().catch((error: unknown) => {
      setProblem(t("compass.incidents.voice.failed", { reason: message(error) }));
      return false;
    });
    void starting$.current.finally(() => setStarting(false));
  };

  const stop = async () => {
    const pending = starting$.current;
    if (!pending) return;
    const started = await pending;
    starting$.current = null;
    if (!started) return;
    try {
      // A release that came before the microphone was ready reaches here just after record(); give the
      // recorder a moment to report that it started before calling it a failure to start.
      const started =
        recorder.isRecording || (await becomes(() => recorder.isRecording, VOICE_START_GRACE_MS));
      const durationMs = recorder.currentTime * 1000;
      const stopped = started && (await within(recorder.stop(), VOICE_STOP_TIMEOUT_MS));
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const note = stopped
        ? keepVoiceNote(recorder.uri, durationMs, new Date().toISOString())
        : null;
      const outcome = voiceStopOutcome({ started, stopped, note });
      if (outcome === "kept" && note) onChange([...notes, note]);
      // didNotStart: the audio session refused to start (another app holds the input, or none is
      // available). didNotSave: it recorded, but saving did not finish in time (a busy device).
      else if (outcome === "didNotStart") setProblem(t("compass.incidents.voice.micDidNotStart"));
      else if (outcome === "didNotSave") setProblem(t("compass.incidents.voice.didNotSave"));
      else setProblem(t("compass.incidents.voice.tooShort"));
    } catch (error: unknown) {
      setProblem(t("compass.incidents.voice.failed", { reason: message(error) }));
    }
  };

  const toggle = (note: VoiceNote) => {
    if (playingId === note.id && playback.playing) {
      player.pause();
      return;
    }
    if (playingId !== note.id) player.replace({ uri: note.uri });
    else if (playback.didJustFinish || playback.currentTime >= playback.duration)
      void player.seekTo(0);
    setPlayingId(note.id);
    player.play();
  };

  const remove = (note: VoiceNote) => {
    if (playingId === note.id) {
      player.pause();
      setPlayingId(null);
    }
    onChange(notes.filter((n) => n.id !== note.id));
  };

  const live = recording.isRecording;
  return (
    <View style={{ gap: theme.space["8"] }}>
      <Pressable
        testID="incident-voice-record"
        accessibilityRole="button"
        accessibilityLabel={
          live
            ? t("compass.incidents.voice.recording", {
                time: formatNoteLength(recording.durationMillis),
              })
            : t("compass.incidents.voice.record")
        }
        accessibilityHint={t("compass.incidents.voice.hint")}
        accessibilityState={{ busy: starting }}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={() => (starting$.current ? void stop() : start())}
        onPressIn={start}
        onPressOut={() => void stop()}
        style={{
          minHeight: theme.density.touchMin + 8,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: theme.space["8"],
          borderRadius: theme.radius.control,
          borderWidth: theme.controlBorderWidth,
          borderColor: theme.color.borderStrong,
          backgroundColor: live ? theme.color.bgRaised : theme.color.bgSurface,
          paddingHorizontal: theme.space["16"],
        }}
      >
        <Icon name="mic" tone={live ? "danger" : "primary"} />
        <Text variant="text16">
          {live
            ? t("compass.incidents.voice.recording", {
                time: formatNoteLength(recording.durationMillis),
              })
            : t("compass.incidents.voice.record")}
        </Text>
      </Pressable>
      {notes.map((note, index) => {
        const playingThis = playingId === note.id && playback.playing;
        return (
          <View
            key={note.id}
            testID={`incident-voice-note-${index}`}
            style={{ flexDirection: "row", alignItems: "center", gap: theme.space["8"] }}
          >
            <IconButton
              testID={`incident-voice-play-${index}`}
              icon={playingThis ? "pause" : "play"}
              label={t(
                playingThis ? "compass.incidents.voice.pause" : "compass.incidents.voice.play",
                {
                  index: index + 1,
                },
              )}
              variant="secondary"
              onPress={() => toggle(note)}
            />
            <View style={{ flex: 1 }}>
              <Text>
                {t("compass.incidents.voice.note", {
                  index: index + 1,
                  length: formatNoteLength(note.durationMs),
                })}
              </Text>
            </View>
            <IconButton
              testID={`incident-voice-delete-${index}`}
              icon="trash-2"
              label={t("compass.incidents.voice.delete", { index: index + 1 })}
              onPress={() => remove(note)}
            />
          </View>
        );
      })}
      {problem ? (
        <InlineAlert testID="incident-voice-problem" tone="warning" message={problem} />
      ) : null}
    </View>
  );
}
