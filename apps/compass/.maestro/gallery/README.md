# Compass component gallery snapshots (A141)

The component gallery shows every `@xos/ui-native` component (the 49 in
`packages/ui-native/src/components.ts`) in its main states, one page per screen, in Dark and in Light
(trace row S11.4-01). Its pages and fixtures live in `packages/ui-native/src/gallery`; Compass opens them at
`compass://dev/gallery?theme=dark&page=1` (`app/dev/gallery.tsx`).

## Where the gallery exists

Only in a build made with `EXPO_PUBLIC_XOS_GALLERY=1`:

- `metro.config.js` leaves `app/dev` out of every other build, so a store build has no gallery route.
- `app.config.ts` refuses the switch in EAS builds, the ones that reach testers and the stores.
- The sitemap (`ia/sitemap.yaml`) and the navigation never list it; nothing in the app links to it.
- In a gallery build the root layout opens `/dev/...` without sign-in, sync or a server.

`test/gallery.test.ts` checks each of these.

## Running the snapshots

1. Prebuild and build Compass for the simulator with the switch (no Supabase stack is needed):

   ```sh
   cd apps/compass
   CI=1 pnpm exec expo prebuild -p ios --no-install && (cd ios && pod install)
   EXPO_PUBLIC_XOS_GALLERY=1 xcodebuild -workspace ios/Compass.xcworkspace -scheme Compass \
     -configuration Release -sdk iphonesimulator -derivedDataPath ios/build ARCHS=arm64 ONLY_ACTIVE_ARCH=YES
   ```

2. Create a simulator of your own of the device type and runtime in `baselines/manifest.json`:

   ```sh
   xcrun simctl create "Gallery" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
     com.apple.CoreSimulator.SimRuntime.iOS-26-5
   ```

3. Run the flows and compare:

   ```sh
   APP=apps/compass/ios/build/Build/Products/Release-iphonesimulator/Compass.app UDID=<udid> \
     apps/compass/scripts/gallery-snapshots.sh
   ```

   Add `--update` to re-record the baselines after an intended visual change, then review the changed
   PNGs in the diff before committing them. Delete the simulator afterwards.

The flows are `../flows/gallery-dark.yaml` and `../flows/gallery-light.yaml`, which run
`../subflows/gallery-pages.yaml`. They open each page by link until the page past the last shows the end
marker, so adding a page needs no flow change. The main suite skips them (`excludeTags: gallery` in
`../config.yaml`), since its release build has no gallery.

## Determinism

- **Clock.** No component reads the time of day: every time, timer and countdown is a fixture. The gallery
  holds timers of a second or more while it is open (`packages/ui-native/src/gallery/clock.ts`), so
  UndoToast's countdown stays on its first second. The status bar, whose clock and battery change, is
  hidden, and `gallery-snapshots.sh` also pins it to 9:41.
- **Fonts.** Compass embeds no font files, so the typography tokens fall back to the iOS system font of
  the pinned runtime. The script sets the default text size (Dynamic Type "large") and English before the
  run, and the gallery's theme uses a text scale of 1.
- **Animation.** No gallery state animates: no loading spinner, no swipe in progress, no open-close
  transition. Sheet and Dialog pages are captured after their modal has settled.
- **Device.** The baselines belong to the simulator and runtime in `baselines/manifest.json`. A capture
  from any other one is not compared (the comparison says so), since fonts and rendering change between
  iOS versions.

## Tolerance

`scripts/gallery-compare.ts` stores and compares pages at one pixel per point (each 3 x 3 block of a
capture averaged into one pixel). A pixel differs when any channel moves by more than 16 of 255; a page
fails when more than 0.01 % of its pixels differ (35 pixels on an iPhone 17 Pro page). A failing page gets
a `.diff.png` beside its capture: the baseline dimmed, with the differing pixels in red.

## Measurements

Taken on 2026-10-28 when the baselines were recorded: an iPhone 17 Pro simulator on iOS 26.5, a Release
gallery build, Maestro 1.39.0. 30 pages a theme, 60 in all, about 1.9 MB of baselines.

| Check                                                                                    | Result                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second run of the same build                                                           | All 60 pages identical: 0 pixels differ, largest channel change 0.                                                                                         |
| `Tag` given 2 points more padding a side (`space["6"]` to `space["8"]`), rebuilt, re-run | 8 pages fail, exactly the four that show a Tag in each theme: chips (2,776 to 2,813 pixels), cards, up next, photo (48 to 101 pixels). The other 52 match. |

The tolerance is therefore not absorbing noise on this simulator; it stays above zero for the
anti-aliasing differences a newer simulator build may bring.

## Owner step for CI

The proposed `compass-gallery-visual` job (`packages/testing/ci/proposed-jobs.yml`) builds the gallery on
GitHub's `macos-15` image. If that image's simulator runtime differs from the manifest, the comparison
stops with "Not compared". Re-record once on the runner: set the repository variable `GALLERY_UPDATE` to
`1` for one run, download the `compass-gallery` artifact, review and commit the baselines it holds, and
remove the variable.
