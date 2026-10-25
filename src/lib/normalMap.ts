import * as THREE from "three";

/**
 * Generates a high-frequency tangent-space normal map from an image using a Sobel operator.
 * This introduces crisp surface micro-relief (fabric textures, skin pores, hair strands,
 * engraved text, embossed details) that monocular depth models often miss.
 */
export async function createNormalMapFromImage(
  imageUrl: string,
  strength: number = 2.0,
): Promise<THREE.CanvasTexture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;

        // Cap to 1024 for fast 60fps computation while preserving fine details
        const maxDim = 1024;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const width = Math.max(32, Math.round(w * scale));
        const height = Math.max(32, Math.round(h * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          reject(new Error("Unable to create 2D canvas context for normal map"));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;

        // Compute perceptual luminance array
        const lum = new Float32Array(width * height);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          const a = data[i + 3]! / 255;
          lum[j] = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * a;
        }

        const getL = (x: number, y: number) => {
          const cx = Math.max(0, Math.min(width - 1, x));
          const cy = Math.max(0, Math.min(height - 1, y));
          return lum[cy * width + cx]!;
        };

        const outData = ctx.createImageData(width, height);
        const out = outData.data;
        const s = Math.max(0.1, strength);

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;

            // 3x3 Sobel kernel
            const tl = getL(x - 1, y - 1);
            const t = getL(x, y - 1);
            const tr = getL(x + 1, y - 1);
            const l = getL(x - 1, y);
            const r = getL(x + 1, y);
            const bl = getL(x - 1, y + 1);
            const b = getL(x, y + 1);
            const br = getL(x + 1, y + 1);

            const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * s;
            const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * s;
            const dz = 1.0;

            const len = Math.hypot(dx, dy, dz) || 1.0;
            const nx = -dx / len;
            const ny = dy / len;
            const nz = dz / len;

            out[idx] = Math.round((nx * 0.5 + 0.5) * 255);
            out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            out[idx + 3] = 255;
          }
        }

        ctx.putImageData(outData, 0, 0);

        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        resolve(texture);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = (e) => reject(new Error("Failed to load image for normal map"));
    img.src = imageUrl;
  });
}
