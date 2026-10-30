"use client";

import { Button } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

/** The labels the page passes in, so no new namespace joins the client bundle. */
export interface BadgePhotoUploadLabels {
  readonly upload: string;
  readonly choose: string;
  readonly cropLabel: string;
  readonly cropHelp: string;
  readonly save: string;
  readonly cancel: string;
  readonly saved: string;
  readonly fileType: string;
  readonly fileSize: string;
}

/** The preview frame and the stored photo: a 3 by 4 portrait, saved as a 600 by 800 JPEG (P5). */
const FRAME = { width: 240, height: 320 };
const OUTPUT = { width: 600, height: 800, quality: 0.85 };
/** The largest photo picked from the device; the saved crop is far smaller. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const STEP = 8;

interface Crop {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Keeps the image covering the whole frame at the zoom chosen. */
function clamp(image: HTMLImageElement, crop: Crop): Crop {
  const scale = Math.max(FRAME.width / image.width, FRAME.height / image.height) * crop.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    zoom: crop.zoom,
    x: Math.min(0, Math.max(FRAME.width - width, crop.x)),
    y: Math.min(0, Math.max(FRAME.height - height, crop.y)),
  };
}

function draw(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  crop: Crop,
  factor: number,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const scale = Math.max(FRAME.width / image.width, FRAME.height / image.height) * crop.zoom;
  // clamp() keeps the photo over the whole frame, so nothing else needs drawing.
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    image,
    crop.x * factor,
    crop.y * factor,
    image.width * scale * factor,
    image.height * scale * factor,
  );
}

/**
 * The holder's badge photo upload (P5): pick or take a photo, crop it by hand to a 3 by 4 portrait (drag the photo,
 * or use the arrow keys, and the zoom slider), and save it as a 600 by 800 JPEG. Nothing detects or reads the face;
 * the crop is the holder's own.
 */
export function BadgePhotoUpload({
  action,
  labels,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  labels: BadgePhotoUploadLabels;
}) {
  const router = useRouter();
  const outcomes = useTranslations("gateway.outcomes") as unknown as (key: string) => string;
  const inputId = useId();
  const helpId = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, zoom: 1 });
  const [message, setMessage] = useState<{ tone: "error" | "done"; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (image && canvas.current) draw(canvas.current, image, crop, 1);
  }, [image, crop]);

  const move = (next: Crop) => image && setCrop(clamp(image, next));

  const pick = (file: File | undefined) => {
    setMessage(null);
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setMessage({ tone: "error", text: labels.fileType });
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setMessage({ tone: "error", text: labels.fileSize });
      return;
    }
    const url = URL.createObjectURL(file);
    const loaded = new Image();
    loaded.onload = () => {
      setImage(loaded);
      setCrop(clamp(loaded, { x: 0, y: 0, zoom: 1 }));
      URL.revokeObjectURL(url);
    };
    loaded.onerror = () => {
      setMessage({ tone: "error", text: labels.fileType });
      URL.revokeObjectURL(url);
    };
    loaded.src = url;
  };

  const save = () => {
    if (!image) return;
    const out = document.createElement("canvas");
    out.width = OUTPUT.width;
    out.height = OUTPUT.height;
    draw(out, image, crop, OUTPUT.width / FRAME.width);
    out.toBlob(
      (blob) => {
        if (!blob) return;
        const form = new FormData();
        form.set("photo", blob, "badge-photo.jpg");
        start(async () => {
          const result = await action(form);
          if (result.ok) {
            setImage(null);
            setMessage({ tone: "done", text: labels.saved });
            router.refresh();
          } else {
            setMessage({ tone: "error", text: outcomes(result.outcome) });
          }
        });
      },
      "image/jpeg",
      OUTPUT.quality,
    );
  };

  return (
    <div className="flex flex-col gap-8">
      <label
        htmlFor={inputId}
        className="inline-flex w-fit cursor-pointer items-center rounded-control border border-border-control bg-bg-surface px-12 py-6 text-text-13 font-medium focus-within:outline-2 focus-within:outline-focus"
      >
        {image ? labels.choose : labels.upload}
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png"
          capture="user"
          className="sr-only"
          onChange={(event) => pick(event.currentTarget.files?.[0])}
        />
      </label>
      {image ? (
        <div className="flex flex-col gap-8">
          <canvas
            ref={canvas}
            width={FRAME.width}
            height={FRAME.height}
            role="img"
            tabIndex={0}
            aria-label={labels.cropLabel}
            aria-describedby={helpId}
            className="h-auto w-180 max-w-full touch-none rounded-md border border-border focus:outline-2 focus:outline-focus"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, crop };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start) return;
              const ratio = FRAME.width / event.currentTarget.getBoundingClientRect().width;
              move({
                zoom: crop.zoom,
                x: start.crop.x + (event.clientX - start.x) * ratio,
                y: start.crop.y + (event.clientY - start.y) * ratio,
              });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onKeyDown={(event) => {
              const delta: Record<string, [number, number]> = {
                ArrowLeft: [STEP, 0],
                ArrowRight: [-STEP, 0],
                ArrowUp: [0, STEP],
                ArrowDown: [0, -STEP],
              };
              const d = delta[event.key];
              if (!d) return;
              event.preventDefault();
              move({ zoom: crop.zoom, x: crop.x + d[0], y: crop.y + d[1] });
            }}
          />
          <p id={helpId} className="m-0 text-text-12 text-text-secondary">
            {labels.cropHelp}
          </p>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={crop.zoom}
            aria-label={labels.cropLabel}
            onChange={(event) => move({ ...crop, zoom: Number(event.currentTarget.value) })}
            className="w-180 max-w-full"
          />
          <span className="flex flex-wrap gap-8">
            <Button
              variant="primary"
              size="sm"
              disabled={pending}
              aria-busy={pending}
              onClick={save}
            >
              {labels.save}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setImage(null);
                setMessage(null);
              }}
            >
              {labels.cancel}
            </Button>
          </span>
        </div>
      ) : null}
      {message ? (
        <span
          role={message.tone === "error" ? "alert" : "status"}
          className={`text-text-12 ${message.tone === "error" ? "text-danger-text" : "text-success-text"}`}
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}
