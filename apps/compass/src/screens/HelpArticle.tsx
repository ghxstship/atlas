import type { Block, Inline } from "@xos/help";
import * as Linking from "expo-linking";
import { useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { Text as NativeText, View } from "react-native";
import { Text, useTheme } from "../ui";

/**
 * A help article body from the parsed Markdown subset (@xos/help), drawn with Compass text. A
 * `help:<slug>` link opens that article; a web address opens in the browser.
 */
export function HelpArticleBody({ blocks }: { readonly blocks: readonly Block[] }): ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const inline = (parts: readonly Inline[]) =>
    parts.map((part, i) => {
      if (part.t === "strong") {
        return (
          <NativeText key={i} style={{ fontWeight: "600" }}>
            {part.v}
          </NativeText>
        );
      }
      if (part.t === "link") {
        const href = part.href;
        const open = href.startsWith("help:")
          ? () => router.push(`/help/${href.slice(5)}` as Href)
          : href.startsWith("https://")
            ? () => void Linking.openURL(href)
            : null;
        return open ? (
          <NativeText
            key={i}
            accessibilityRole="link"
            onPress={open}
            style={{ color: theme.color.accentText, textDecorationLine: "underline" }}
          >
            {part.v}
          </NativeText>
        ) : (
          <NativeText key={i}>{part.v}</NativeText>
        );
      }
      return <NativeText key={i}>{part.v}</NativeText>;
    });
  return (
    <View style={{ gap: theme.space["12"] }}>
      {blocks.map((block, i) => {
        if (block.t === "h2" || block.t === "h3") {
          return (
            <Text key={i} variant={block.t === "h2" ? "heading20" : "heading16"} heading>
              {block.v}
            </Text>
          );
        }
        if (block.t === "p") return <Text key={i}>{inline(block.c)}</Text>;
        return (
          <View key={i} style={{ gap: theme.space["6"] }}>
            {block.items.map((item, j) => (
              <View key={j} style={{ flexDirection: "row", gap: theme.space["8"] }}>
                <Text>{block.t === "ol" ? `${j + 1}.` : "•"}</Text>
                <View style={{ flex: 1 }}>
                  <Text>{inline(item)}</Text>
                </View>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}
