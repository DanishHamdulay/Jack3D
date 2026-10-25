/**
 * Utility functions for image color sampling and processing.
 */

/**
 * Samples the perimeter/boundary pixels of an image or cutout to compute
 * the dominant/average edge (side) color in hex format (e.g. "#3f3f46").
 */
export function extractEdgeColor(imageUrl: string): Promise<string> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !imageUrl) {
      resolve("#27272a");
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 128;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve("#27272a");
          return;
        }

        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        // Sample non-transparent pixels that border transparency or image perimeter
        const step = 2;
        for (let y = 0; y < size; y += step) {
          for (let x = 0; x < size; x += step) {
            const idx = (y * size + x) * 4;
            const a = data[idx + 3] ?? 0;
            if (a < 40) continue; // transparent pixel

            let isEdge = x <= 3 || x >= size - 4 || y <= 3 || y >= size - 4;
            if (!isEdge) {
              // check 4-neighborhood
              const leftA = data[(y * size + (x - 2)) * 4 + 3] ?? 0;
              const rightA = data[(y * size + (x + 2)) * 4 + 3] ?? 0;
              const topA = data[((y - 2) * size + x) * 4 + 3] ?? 0;
              const botA = data[((y + 2) * size + x) * 4 + 3] ?? 0;
              if (leftA < 40 || rightA < 40 || topA < 40 || botA < 40) {
                isEdge = true;
              }
            }

            if (isEdge) {
              rSum += data[idx] ?? 0;
              gSum += data[idx + 1] ?? 0;
              bSum += data[idx + 2] ?? 0;
              count++;
            }
          }
        }

        if (count > 0) {
          const r = Math.round(rSum / count);
          const g = Math.round(gSum / count);
          const b = Math.round(bSum / count);
          const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
          resolve(hex);
        } else {
          resolve("#27272a");
        }
      } catch (e) {
        console.warn("Could not extract edge color:", e);
        resolve("#27272a");
      }
    };
    img.onerror = () => resolve("#27272a");
    img.src = imageUrl;
  });
}
