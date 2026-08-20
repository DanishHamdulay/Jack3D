// Browser-only depth estimation. Never import this from SSR module scope.
import type { PipelineType } from "@huggingface/transformers";

export type DepthResult = {
  depth: Float32Array; // normalized 0..1, row-major
  width: number;
  height: number;
};

let pipePromise: Promise<any> | null = null;

async function getPipe(onProgress?: (p: number) => void) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      return pipeline("depth-estimation" as PipelineType, "onnx-community/depth-anything-v2-small", {
        dtype: "q8",
        progress_callback: (data: any) => {
          if (data?.status === "progress" && typeof data.progress === "number") {
            onProgress?.(Math.min(99, Math.round(data.progress)));
          }
        },
      });
    })();
  }
  return pipePromise;
}

export async function estimateDepth(
  imageUrl: string,
  onProgress?: (p: number) => void,
): Promise<DepthResult> {
  const pipe = await getPipe(onProgress);
  const out = await pipe(imageUrl);
  const raw = out.depth ?? out.predicted_depth;
  const width: number = raw.width ?? raw.dims[raw.dims.length - 1];
  const height: number = raw.height ?? raw.dims[raw.dims.length - 2];
  const data: ArrayLike<number> = raw.data;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const depth = new Float32Array(width * height);
  for (let i = 0; i < depth.length; i++) {
    depth[i] = ((data[i] as number) - min) / span;
  }
  return { depth, width, height };
}
