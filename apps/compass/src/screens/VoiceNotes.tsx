/**
 * Voice notes on an incident report (SIM-003, journey 54; Section 11.13 Incidents). Hold the microphone to
 * record, release to stop; each note plays back and can be deleted before the report is sent. The files stay
 * on the device until the queued report uploads them to field-media, so recording works offline.
 * VoiceOver users double-tap to start and double-tap again to stop, since a hold is not available to them.
 */
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { formatNoteLength, keepVoiceNote, type VoiceNote } from "../domain/incidents";
import { Icon, IconButton, InlineAlert, Text, useTheme } from "../ui";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recording = useAudioRecorderState(recorder, 250);
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    if (recording.isRecording || starting) return;
    setProblem(null);
    setStarting(true);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setProblem(t("compass.incidents.voice.permissionDenied"));
        return;
      }
      player.pause();
      setPlayingId(null);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error: unknown) {
      setProblem(t("compass.incidents.voice.failed", { reason: message(error) }));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!recorder.isRecording) return;
    try {
      const durationMs = recorder.currentTime * 1000;
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const note = keepVoiceNote(recorder.uri, durationMs, new Date().toISOString());
      if (note) onChange([...notes, note]);
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
        onAccessibilityAction={() => void (live ? stop() : start())}
        onPressIn={() => void start()}
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
