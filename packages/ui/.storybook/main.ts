import tailwind from "@tailwindcss/postcss";
import type { StorybookConfig } from "@storybook/react-vite";

/**
 * Storybook for @xos/ui (RRR-34), pinned at 10.6.1 (ADR 0001). Stories come from the design
 * previews (stories/generated, one per component) plus hand-written showcase stories. The
 * stylesheet is the same Tailwind 4 entry apps import, compiled through @tailwindcss/postcss.
 */
const config: StorybookConfig = {
  framework: { name: "@storybook/react-vite", options: {} },
  stories: ["../stories/**/*.stories.@(js|tsx)"],
  staticDirs: ["../stories/static"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-themes"],
  core: { disableTelemetry: true },
  typescript: { reactDocgen: false },
  viteFinal: (vite) => ({
    ...vite,
    css: { ...vite.css, postcss: { plugins: [tailwind()] } },
    oxc: { jsx: { runtime: "automatic" } },
  }),
};

export default config;
