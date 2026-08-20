// Browser-only background removal. Never import from SSR module scope.
export type CutoutResult = {
  /** object URL of the RGBA cutout (transparent background) */
  url: string;
  /** alpha 0..1 per pixel, row-major */
  alpha: Float32Array;
  width: number;
  height: number;
};

let segPromise: Promise<any> | null = null;

async function getSegmenter(onProgress?: (p: number) => void) {
  if (!segPromise) {
    segPromise = (async () => {
      const { AutoModel, AutoProcessor, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      const progress_callback = (data: any) => {
        if (data?.status === "progress" && typeof data.progress === "number") {
          onProgress?.(Math.min(99, Math.round(data.progress)));
        }
      };
      const model = await AutoModel.from_pretrained("briaai/RMBG-1.4", {
        config: { model_type: "custom" } as any,
        progress_callback,
      } as any);
      const processor = await AutoProcessor.from_pretrained("briaai/RMBG-1.4", {
        config: {
          do_normalize: true,
          do_pad: false,
          do_rescale: true,
          do_resize: true,
          image_mean: [0.5, 0.5, 0.5],
          image_std: [1, 1, 1],
          resample: 2,
          rescale_factor: 1 / 255,
          size: { width: 1024, height: 1024 },
        } as any,
      } as any);
      return { model, processor };
    })();
  }
  return segPromise;
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

/** Softens + trims the alpha edge so the cutout silhouette is clean. */
function refineAlpha(alpha: Float32Array, w: number, h: number) {
  const out = new Float32Array(alpha.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          sum += alpha[ny * w + nx] ?? 0;
          n++;
        }
      }
      const v = sum / n;
      // push towards 0/1 to kill halos
      out[y * w + x] = v < 0.35 ? 0 : v > 0.65 ? 1 : (v - 0.35) / 0.3;
    }
  }
  return out;
}

export async function removeBackground(
  imageUrl: string,
  onProgress?: (p: number) => void,
): Promise<CutoutResult> {
  const segmenter = await getSegmenter(onProgress);
  const img = await loadImage(imageUrl);

  const maxSide = 1024;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);

  const { model, processor } = await segmenter;
  const { RawImage } = await import("@huggingface/transformers");
  const input = await RawImage.fromURL(imageUrl);
  const { pixel_values } = await processor(input);
  const { output } = await model({ input: pixel_values });
  const maskImage = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(w, h);
  const md = maskImage.data as ArrayLike<number>;
  const mw: number = maskImage.width;
  const mh: number = maskImage.height;
  const channels: number = maskImage.channels ?? Math.round(md.length / (mw * mh));


  const alphaRaw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, Math.round((y / h) * mh));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, Math.round((x / w) * mw));
      const idx = (sy * mw + sx) * channels + (channels === 4 ? 3 : 0);
      alphaRaw[y * w + x] = ((md[idx] as number) ?? 0) / 255;
    }
  }
  const alpha = refineAlpha(alphaRaw, w, h);


  const imgData = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    imgData.data[i * 4 + 3] = Math.round((alpha[i] ?? 0) * 255);
  }
  ctx.putImageData(imgData, 0, 0);

  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
  return { url: URL.createObjectURL(blob), alpha, width: w, height: h };
}
