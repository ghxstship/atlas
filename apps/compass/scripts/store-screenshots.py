"""Sizes the raw Compass store captures for each store (RRR-113). Run by scripts/store-screenshots.sh.

    python3 store-screenshots.py <raw dir> <display type> <apple locale> <play locale> <store dir>

<display type> is APP_IPHONE_67 (iPhone 6.9-inch captures, 1320 x 2868) or APP_IPHONE_65 (6.5-inch,
1242 x 2688). Each raw-<NN-name>.png is copied unchanged for the App Store. The 6.9-inch captures also
become the Google Play phone screenshots: the iOS status bar is cropped off, the
left and right edge columns are repeated out to a 9:16 frame (so cards and the tab bar keep their own
colours), and the result is scaled to 1080 x 1920, Play's size for promotable phone screenshots.
Needs Pillow (python3 -m pip install pillow).
"""
import os
import sys

from PIL import Image

NAMES = ["01-today", "02-schedule", "03-scan", "04-incident", "05-show"]
APPLE_SIZES = {"APP_IPHONE_67": (1320, 2868), "APP_IPHONE_65": (1242, 2688)}
# Pixels to drop at the top of a 6.9-inch capture: the iOS status bar (simulator captures carry no home
# indicator, and screens with a bottom button run to the bottom edge, so nothing is cut there).
STATUS_BAR_PX = 150
PLAY_SIZE = (1080, 1920)


def play_frame(image: Image.Image) -> Image.Image:
    width, height = image.size
    body = image.crop((0, STATUS_BAR_PX, width, height))
    target_width = round(body.height * PLAY_SIZE[0] / PLAY_SIZE[1])
    pad = max(0, target_width - width)
    left, right = pad // 2, pad - pad // 2
    frame = Image.new("RGB", (width + pad, body.height))
    frame.paste(body, (left, 0))
    left_edge = body.crop((0, 0, 1, body.height)).resize((left, body.height)) if left else None
    right_edge = body.crop((width - 1, 0, width, body.height)).resize((right, body.height)) if right else None
    if left_edge:
        frame.paste(left_edge, (0, 0))
    if right_edge:
        frame.paste(right_edge, (left + width, 0))
    return frame.resize(PLAY_SIZE, Image.LANCZOS)


def main(raw_dir: str, display: str, apple_locale: str, play_locale: str, store_dir: str) -> int:
    expected = APPLE_SIZES[display]
    apple_dir = os.path.join(store_dir, "apple", "screenshot", apple_locale, display)
    play_dir = os.path.join(store_dir, "google-play", play_locale, "phone")
    os.makedirs(apple_dir, exist_ok=True)
    for name in NAMES:
        raw = os.path.join(raw_dir, f"raw-{name}.png")
        image = Image.open(raw).convert("RGB")
        if image.size != expected:
            print(f"{raw} is {image.size}, expected {expected} for {display}")
            return 1
        image.save(os.path.join(apple_dir, f"{name}.png"), optimize=True)
        if display == "APP_IPHONE_67":
            os.makedirs(play_dir, exist_ok=True)
            play_frame(image).save(os.path.join(play_dir, f"{name}.png"), optimize=True)
    print(f"{display} {apple_locale}: {len(NAMES)} screenshots" + (f", Play {play_locale}" if display == "APP_IPHONE_67" else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:6]))
