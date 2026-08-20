// Browser-only object detection. Never import this from SSR module scope.
import type { PipelineType } from "@huggingface/transformers";

export type DetectResult = {
  /** object URL of the image cropped tightly (with padding) around the subject */
  url: string;
  label: string;
  score: number;
  box: { x: number; y: number; w: number; h: number };
};

let detPromise: Promise<any> | null = null;

async function getDetector(onProgress?: (p: number) => void) {
  if (!detPromise) {
    detPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      return pipeline("object-detection" as PipelineType, "Xenova/detr-resnet-50", {
        dtype: "q8",
        progress_callback: (data: any) => {
          if (data?.status === "progress" && typeof data.progress === "number") {
            onProgress?.(Math.min(99, Math.round(data.progress)));
          }
        },
      });
    })();
  }
  return detPromise;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Finds the dominant object in the photo and returns a padded crop of it.
 * Returns null when nothing confident is found — the caller then uses the
 * original frame.
 */
export async function detectSubject(
  imageUrl: string,
  onProgress?: (p: number) => void,
): Promise<DetectResult | null> {
  const detector = await getDetector(onProgress);
  const results: any[] = await detector(imageUrl, { threshold: 0.35, percentage: false });
  if (!results?.length) return null;

  const img = await loadImage(imageUrl);
  // pick the highest scoring, largest object
  let best: any = null;
  let bestScore = -1;
  for (const r of results) {
    const b = r.box;
    const area = ((b.xmax - b.xmin) * (b.ymax - b.ymin)) / (img.width * img.height);
    const s = r.score * (0.4 + Math.min(1, area));
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (!best) return null;

  const b = best.box;
  const padX = (b.xmax - b.xmin) * 0.08;
  const padY = (b.ymax - b.ymin) * 0.08;
  const x = Math.max(0, Math.floor(b.xmin - padX));
  const y = Math.max(0, Math.floor(b.ymin - padY));
  const w = Math.min(img.width - x, Math.ceil(b.xmax - b.xmin + padX * 2));
  const h = Math.min(img.height - y, Math.ceil(b.ymax - b.ymin + padY * 2));
  if (w < 24 || h < 24) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  const blob: Blob = await new Promise((res) => canvas.toBlob((bb) => res(bb!), "image/png"));

  return {
    url: URL.createObjectURL(blob),
    label: String(best.label ?? "object"),
    score: Number(best.score ?? 0),
    box: { x, y, w, h },
  };
}
