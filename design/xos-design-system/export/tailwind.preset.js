/* XOS Design System: Tailwind CSS preset for packages/config.
   Generated from project/tokens.json; every value reads a CSS variable emitted by packages/tokens
   (Style Dictionary), so white-label overrides and theme switches need no rebuild.
   No raw color, size or radius appears in class output. Stroke widths carry a stroke- prefix (border-stroke-accent,
   outline-stroke-focus) so a width class never collides with a color class such as border-accent.
   Tailwind 4.3.3 (the repo pin) loads it from a config file named in CSS:
     tailwind.config.cjs:  module.exports = { presets: [require("@xos/config/tailwind/preset.js")] };
     app CSS:              @import "tailwindcss"; @config "./tailwind.config.cjs";
   Verified on 4.3.3 and 3.4.17. */
module.exports = {
 "darkMode": [
  "selector",
  "[data-theme=\"dark\"]"
 ],
 "theme": {
  "colors": {
   "bg": {
    "canvas": "var(--color-bg-canvas)",
    "surface": "var(--color-bg-surface)",
    "raised": "var(--color-bg-raised)",
    "hover": "var(--color-bg-hover)"
   },
   "border": {
    "subtle": "var(--color-border-subtle)",
    "strong": "var(--color-border-strong)",
    "control": "var(--color-border-control)"
   },
   "text": {
    "primary": "var(--color-text-primary)",
    "secondary": "var(--color-text-secondary)",
    "tertiary": "var(--color-text-tertiary)"
   },
   "accent": {
    "DEFAULT": "var(--color-accent-default)",
    "text-on": "var(--color-accent-text-on)",
    "text": "var(--color-accent-text)"
   },
   "focus": {
    "ring": "var(--color-focus-ring)"
   },
   "danger": "var(--color-danger)",
   "warning": "var(--color-warning)",
   "success": "var(--color-success)",
   "danger-text": "var(--color-danger-text)",
   "danger-text-on": "var(--color-danger-text-on)",
   "warning-text": "var(--color-warning-text)",
   "success-text": "var(--color-success-text)",
   "state": {
    "proposed": "var(--color-state-proposed)",
    "ready": "var(--color-state-ready)",
    "scheduled": "var(--color-state-scheduled)",
    "active": "var(--color-state-active)",
    "blocked": "var(--color-state-blocked)",
    "in-review": "var(--color-state-in-review)",
    "complete": "var(--color-state-complete)",
    "deferred": "var(--color-state-deferred)",
    "canceled": "var(--color-state-canceled)"
   },
   "viz": {
    "ink": "var(--color-viz-ink)",
    "cat-1": "var(--color-viz-cat-1)",
    "cat-2": "var(--color-viz-cat-2)",
    "cat-3": "var(--color-viz-cat-3)",
    "cat-4": "var(--color-viz-cat-4)",
    "cat-5": "var(--color-viz-cat-5)",
    "cat-6": "var(--color-viz-cat-6)",
    "cat-7": "var(--color-viz-cat-7)",
    "other": "var(--color-viz-other)",
    "seq-1": "var(--color-viz-seq-1)",
    "seq-2": "var(--color-viz-seq-2)",
    "seq-3": "var(--color-viz-seq-3)",
    "seq-4": "var(--color-viz-seq-4)",
    "seq-5": "var(--color-viz-seq-5)",
    "seq-6": "var(--color-viz-seq-6)",
    "seq-7": "var(--color-viz-seq-7)",
    "seq-8": "var(--color-viz-seq-8)",
    "seq-9": "var(--color-viz-seq-9)",
    "div-1": "var(--color-viz-div-1)",
    "div-2": "var(--color-viz-div-2)",
    "div-3": "var(--color-viz-div-3)",
    "div-4": "var(--color-viz-div-4)",
    "div-5": "var(--color-viz-div-5)",
    "div-6": "var(--color-viz-div-6)",
    "div-7": "var(--color-viz-div-7)"
   },
   "paper": "var(--color-paper)",
   "paper-ink": "var(--color-paper-ink)",
   "camera-bg": "var(--color-camera-bg)",
   "camera-ink": "var(--color-camera-ink)",
   "ecode": {
    "red": "var(--color-ecode-red)",
    "orange": "var(--color-ecode-orange)",
    "yellow": "var(--color-ecode-yellow)",
    "green": "var(--color-ecode-green)",
    "blue": "var(--color-ecode-blue)",
    "purple": "var(--color-ecode-purple)",
    "white": "var(--color-ecode-white)",
    "black": "var(--color-ecode-black)",
    "pink": "var(--color-ecode-pink)",
    "indigo": "var(--color-ecode-indigo)",
    "silver": "var(--color-ecode-silver)",
    "grey": "var(--color-ecode-grey)",
    "amber": "var(--color-ecode-amber)",
    "adam": "var(--color-ecode-adam)"
   },
   "scrim": "var(--color-scrim)",
   "transparent": "transparent",
   "current": "currentColor"
  },
  "spacing": {
   "0": "0px",
   "2": "var(--space-2)",
   "4": "var(--space-4)",
   "6": "var(--space-6)",
   "8": "var(--space-8)",
   "12": "var(--space-12)",
   "16": "var(--space-16)",
   "20": "var(--space-20)",
   "24": "var(--space-24)",
   "32": "var(--space-32)",
   "40": "var(--space-40)",
   "48": "var(--space-48)",
   "64": "var(--space-64)"
  },
  "borderRadius": {
   "none": "0px",
   "full": "9999px",
   "chip": "var(--radius-chip)",
   "control": "var(--radius-control)",
   "card": "var(--radius-card)",
   "dialog": "var(--radius-dialog)",
   "mark": "var(--radius-mark)",
   "pill": "var(--radius-pill)",
   "widget": "var(--radius-widget)",
   "device": "var(--radius-device)"
  },
  "borderWidth": {
   "0": "0px",
   "DEFAULT": "var(--stroke-width-hairline)",
   "stroke-hairline": "var(--stroke-width-hairline)",
   "stroke-focus": "var(--stroke-width-focus)",
   "stroke-accent": "var(--stroke-width-accent)",
   "stroke-swatch": "var(--stroke-width-swatch)",
   "stroke-stripe": "var(--stroke-width-stripe)"
  },
  "outlineWidth": {
   "stroke-hairline": "var(--stroke-width-hairline)",
   "stroke-focus": "var(--stroke-width-focus)",
   "stroke-accent": "var(--stroke-width-accent)",
   "stroke-swatch": "var(--stroke-width-swatch)",
   "stroke-stripe": "var(--stroke-width-stripe)"
  },
  "boxShadow": {
   "none": "none",
   "menu": "var(--shadow-menu)",
   "dialog": "var(--shadow-dialog)"
  },
  "opacity": {
   "disabled": "var(--opacity-disabled)",
   "scrim-dark": "var(--opacity-scrim-dark)",
   "scrim-light": "var(--opacity-scrim-light)",
   "hover": "var(--opacity-hover)",
   "pressed": "var(--opacity-pressed)"
  },
  "zIndex": {
   "base": "var(--z-base)",
   "sticky": "var(--z-sticky)",
   "sidebar": "var(--z-sidebar)",
   "header": "var(--z-header)",
   "dropdown": "var(--z-dropdown)",
   "popover": "var(--z-popover)",
   "peek": "var(--z-peek)",
   "dialog": "var(--z-dialog)",
   "command": "var(--z-command)",
   "toast": "var(--z-toast)",
   "tooltip": "var(--z-tooltip)"
  },
  "screens": {
   "sm": "640px",
   "md": "768px",
   "lg": "1024px",
   "xl": "1280px",
   "2xl": "1536px",
   "3xl": "1920px"
  },
  "fontFamily": {
   "sans": "var(--font-family-sans)",
   "mono": "var(--font-family-mono)"
  },
  "fontWeight": {
   "regular": "var(--font-weight-regular)",
   "medium": "var(--font-weight-medium)",
   "semibold": "var(--font-weight-semibold)",
   "bold": "var(--font-weight-bold)"
  },
  "fontSize": {
   "text-11": [
    "11px",
    {
     "lineHeight": "1.45"
    }
   ],
   "text-12": [
    "12px",
    {
     "lineHeight": "1.45"
    }
   ],
   "text-13": [
    "13px",
    {
     "lineHeight": "1.45"
    }
   ],
   "text-14": [
    "14px",
    {
     "lineHeight": "1.45"
    }
   ],
   "text-16": [
    "16px",
    {
     "lineHeight": "1.45"
    }
   ],
   "label-13": [
    "13px",
    {
     "lineHeight": "1.45"
    }
   ],
   "heading-16": [
    "16px",
    {
     "lineHeight": "1.2"
    }
   ],
   "heading-20": [
    "20px",
    {
     "lineHeight": "1.2"
    }
   ],
   "heading-24": [
    "24px",
    {
     "lineHeight": "1.2"
    }
   ],
   "heading-32": [
    "32px",
    {
     "lineHeight": "1.2"
    }
   ],
   "mono-12": [
    "12px",
    {
     "lineHeight": "1.45"
    }
   ],
   "mono-13": [
    "13px",
    {
     "lineHeight": "1.45"
    }
   ]
  },
  "transitionDuration": {
   "instant": "var(--motion-duration-instant)",
   "fast": "var(--motion-duration-fast)",
   "base": "var(--motion-duration-base)",
   "slow": "var(--motion-duration-slow)",
   "deliberate": "var(--motion-duration-deliberate)",
   "reduced": "var(--motion-duration-reduced)"
  },
  "transitionTimingFunction": {
   "standard": "var(--motion-easing-standard)",
   "enter": "var(--motion-easing-enter)",
   "exit": "var(--motion-easing-exit)"
  },
  "extend": {
   "height": {
    "row-compact": "var(--density-row-compact)",
    "row-default": "var(--density-row-default)",
    "row-comfortable": "var(--density-row-comfortable)",
    "control-sm": "var(--density-control-sm)",
    "control-md": "var(--density-control-md)",
    "control-lg": "var(--density-control-lg)",
    "touch-min": "var(--density-touch-min)",
    "target-fine": "var(--density-target-fine)",
    "target-coarse": "var(--density-target-coarse)"
   },
   "minHeight": {
    "row-compact": "var(--density-row-compact)",
    "row-default": "var(--density-row-default)",
    "row-comfortable": "var(--density-row-comfortable)",
    "control-sm": "var(--density-control-sm)",
    "control-md": "var(--density-control-md)",
    "control-lg": "var(--density-control-lg)",
    "touch-min": "var(--density-touch-min)",
    "target-fine": "var(--density-target-fine)",
    "target-coarse": "var(--density-target-coarse)"
   },
   "minWidth": {
    "row-compact": "var(--density-row-compact)",
    "row-default": "var(--density-row-default)",
    "row-comfortable": "var(--density-row-comfortable)",
    "control-sm": "var(--density-control-sm)",
    "control-md": "var(--density-control-md)",
    "control-lg": "var(--density-control-lg)",
    "touch-min": "var(--density-touch-min)",
    "target-fine": "var(--density-target-fine)",
    "target-coarse": "var(--density-target-coarse)"
   },
   "width": {
    "layout-sidebar": "var(--layout-sidebar)",
    "layout-sidebar-collapsed": "var(--layout-sidebar-collapsed)",
    "layout-sidebar-min": "var(--layout-sidebar-min)",
    "layout-sidebar-max": "var(--layout-sidebar-max)",
    "layout-peek": "var(--layout-peek)",
    "layout-peek-min": "var(--layout-peek-min)",
    "layout-peek-max": "var(--layout-peek-max)",
    "layout-property-column": "var(--layout-property-column)",
    "layout-auth": "var(--layout-auth)",
    "layout-form": "var(--layout-form)",
    "layout-reading": "var(--layout-reading)",
    "layout-wide": "var(--layout-wide)",
    "grid-gutter": "var(--layout-gutter)",
    "grid-gutter-lg": "var(--layout-gutter-lg)"
   },
   "maxWidth": {
    "layout-sidebar": "var(--layout-sidebar)",
    "layout-sidebar-collapsed": "var(--layout-sidebar-collapsed)",
    "layout-sidebar-min": "var(--layout-sidebar-min)",
    "layout-sidebar-max": "var(--layout-sidebar-max)",
    "layout-peek": "var(--layout-peek)",
    "layout-peek-min": "var(--layout-peek-min)",
    "layout-peek-max": "var(--layout-peek-max)",
    "layout-property-column": "var(--layout-property-column)",
    "layout-auth": "var(--layout-auth)",
    "layout-form": "var(--layout-form)",
    "layout-reading": "var(--layout-reading)",
    "layout-wide": "var(--layout-wide)",
    "grid-gutter": "var(--layout-gutter)",
    "grid-gutter-lg": "var(--layout-gutter-lg)"
   },
   "size": {
    "icon-12": "var(--icon-size-12)",
    "icon-14": "var(--icon-size-14)",
    "icon-16": "var(--icon-size-16)",
    "icon-20": "var(--icon-size-20)",
    "icon-24": "var(--icon-size-24)",
    "icon-28": "var(--icon-size-28)"
   }
  }
 }
};
