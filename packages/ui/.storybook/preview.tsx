import "@xos/tokens/css/base.css";
import "@xos/tokens/css/theme.dark.css";
import "@xos/tokens/css/theme.light.css";
import "@xos/tokens/css/theme.sunlight.css";
import "../src/styles/index.css";
import "../src/styles/base.css";
import "../src/styles/components.css";
import "../stories/preview.css";
import { useEffect, type ReactElement } from "react";
import type { Decorator, Preview } from "@storybook/react-vite";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import arXB from "@xos/i18n/messages/pseudo/ar-XB.json" with { type: "json" };
import { XOSProvider, flattenMessages } from "../src/index.ts";

const rtlMessages = flattenMessages(arXB);

/** Direction toolbar: RTL renders under the ar-XB pseudo-locale, mirrored, with Arabic direction. */
const withDirection: Decorator = (Story, context): ReactElement => {
  const rtl = context.globals["direction"] === "rtl";
  useEffect(() => {
    document.documentElement.dir = rtl ? "rtl" : "ltr";
    document.documentElement.lang = rtl ? "ar" : "en-US";
  }, [rtl]);
  return (
    <XOSProvider locale={rtl ? "ar" : "en-US"} {...(rtl ? { messages: rtlMessages } : {})}>
      <div className="xos-story font-sans text-text-13 text-text-primary">
        <Story />
      </div>
    </XOSProvider>
  );
};

const preview: Preview = {
  globalTypes: {
    direction: {
      description: "Text direction",
      toolbar: {
        title: "Direction",
        icon: "transfer",
        items: [
          { value: "ltr", title: "Left to right" },
          { value: "rtl", title: "Right to left" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { direction: "ltr" },
  decorators: [
    withDirection,
    withThemeByDataAttribute({
      themes: { Dark: "dark", Light: "light", Sunlight: "sunlight" },
      defaultTheme: "Dark",
      attributeName: "data-theme",
    }),
  ],
  parameters: {
    layout: "padded",
    a11y: { test: "error", options: { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } },
  },
};

export default preview;
