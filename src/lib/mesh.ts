import * as THREE from "three";
import type { DepthResult } from "@/lib/depth";
import type { CutoutResult } from "@/lib/segment";

export type MeshOptions = {
  relief: number;
  smooth: number;
  /** 0..1 — how thick the back shell is relative to relief */
  thickness: number;
};

function sampleBilinear(data: Float32Array, w: number, h: number, u: number, v: number) {
  const x = Math.min(w - 1, Math.max(0, u * (w - 1)));
  const y = Math.min(h - 1, Math.max(0, v * (h - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0] ?? 0;
  const b = data[y0 * w + x1] ?? 0;
  const c = data[y1 * w + x0] ?? 0;
  const d = data[y1 * w + x1] ?? 0;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Builds a closed, watertight solid: displaced front surface, mirrored back
 * shell and a rim skirt joining them — so the model reads correctly from every
 * angle. Geometry is limited to the cutout silhouette when a mask is given.
 */
export function buildSolidGeometry(
  depth: DepthResult,
  cutout: CutoutResult | null,
  { relief, smooth, thickness }: MeshOptions,
) {
  const aspect = depth.width / depth.height;
  const segX = Math.min(360, Math.max(64, depth.width));
  const segY = Math.max(32, Math.round(segX / aspect));


  const planeW = aspect >= 1 ? 3 : 3 * aspect;
  const planeH = aspect >= 1 ? 3 / aspect : 3;

  // sample depth + mask onto the grid
  const n = segX * segY;
  const dvals = new Float32Array(n);
  const mask = new Uint8Array(n);
  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const u = ix / (segX - 1);
      const v = iy / (segY - 1);
      const i = iy * segX + ix;
      dvals[i] = sampleBilinear(depth.depth, depth.width, depth.height, u, v);
      if (cutout) {
        const a = sampleBilinear(cutout.alpha, cutout.width, cutout.height, u, v);
        mask[i] = a > 0.5 ? 1 : 0;
      } else {
        mask[i] = 1;
      }
    }
  }

  // erode one ring so the silhouette has no stray speckles
  if (cutout) {
    const eroded = new Uint8Array(mask);
    for (let iy = 0; iy < segY; iy++) {
      for (let ix = 0; ix < segX; ix++) {
        const i = iy * segX + ix;
        if (!mask[i]) continue;
        let keep = 1;
        for (let dy = -1; dy <= 1 && keep; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = ix + dx;
            const ny = iy + dy;
            if (nx < 0 || ny < 0 || nx >= segX || ny >= segY || !mask[ny * segX + nx]) {
              keep = 0;
              break;
            }
          }
        }
        eroded[i] = keep;
      }
    }
    mask.set(eroded);
  }

  // smoothing passes (masked)
  const tmp = new Float32Array(n);
  for (let p = 0; p < Math.round(smooth) + 2; p++) {
    for (let iy = 0; iy < segY; iy++) {
      for (let ix = 0; ix < segX; ix++) {
        const i = iy * segX + ix;
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = ix + dx;
            const ny = iy + dy;
            if (nx < 0 || ny < 0 || nx >= segX || ny >= segY) continue;
            const j = ny * segX + nx;
            if (!mask[j]) continue;
            sum += dvals[j] ?? 0;
            cnt++;
          }
        }
        tmp[i] = cnt ? sum / cnt : (dvals[i] ?? 0);
      }
    }
    dvals.set(tmp);
  }

  // taper depth near the silhouette edge so the solid closes smoothly
  const edgeFade = new Float32Array(n).fill(1);
  if (cutout) {
    const STEP = 0.14; // smaller step => wider, rounder rim
    for (let pass = 0; pass < 8; pass++) {
      const next = new Float32Array(edgeFade);
      for (let iy = 0; iy < segY; iy++) {
        for (let ix = 0; ix < segX; ix++) {
          const i = iy * segX + ix;
          if (!mask[i]) {
            next[i] = 0;
            continue;
          }
          let min = 1;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = ix + dx;
              const ny = iy + dy;
              if (nx < 0 || ny < 0 || nx >= segX || ny >= segY) continue;
              min = Math.min(min, mask[ny * segX + nx] ? (edgeFade[ny * segX + nx] ?? 1) : 0);
            }
          }
          next[i] = Math.min(edgeFade[i] ?? 1, min + STEP);
        }
      }
      edgeFade.set(next);
    }
    // dome profile: rounded shoulder instead of a hard chamfer
    for (let i = 0; i < n; i++) {
      const t = edgeFade[i] ?? 1;
      edgeFade[i] = Math.sqrt(Math.max(0, Math.min(1, t)));
    }
  }


  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const frontIdx = new Int32Array(n).fill(-1);
  const backIdx = new Int32Array(n).fill(-1);

  const px = (ix: number) => (ix / (segX - 1) - 0.5) * planeW;
  const py = (iy: number) => (0.5 - iy / (segY - 1)) * planeH;

  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const i = iy * segX + ix;
      if (!mask[i]) continue;
      const fade = edgeFade[i] ?? 1;
      const d = ((dvals[i] ?? 0.5) - 0.5) * relief * fade;
      const x = px(ix);
      const y = py(iy);
      const u = ix / (segX - 1);
      const v = 1 - iy / (segY - 1);

      frontIdx[i] = positions.length / 3;
      positions.push(x, y, d + 0.001 * fade);
      uvs.push(u, v);

      backIdx[i] = positions.length / 3;
      positions.push(x, y, d - relief * thickness * fade - 0.001 * fade);
      uvs.push(u, v);
    }
  }

  const quad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d);
  };

  for (let iy = 0; iy < segY - 1; iy++) {
    for (let ix = 0; ix < segX - 1; ix++) {
      const i00 = iy * segX + ix;
      const i10 = iy * segX + ix + 1;
      const i01 = (iy + 1) * segX + ix;
      const i11 = (iy + 1) * segX + ix + 1;
      if (!mask[i00] || !mask[i10] || !mask[i01] || !mask[i11]) continue;
      // front (CCW facing +Z)
      quad(frontIdx[i00]!, frontIdx[i01]!, frontIdx[i11]!, frontIdx[i10]!);
      // back (reversed)
      quad(backIdx[i00]!, backIdx[i10]!, backIdx[i11]!, backIdx[i01]!);
    }
  }

  // rim: connect front/back along silhouette boundary edges
  const boundary = (a: number, b: number) => {
    if (!mask[a] || !mask[b]) return false;
    return true;
  };
  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const i = iy * segX + ix;
      if (!mask[i]) continue;
      // horizontal edge to the right
      if (ix < segX - 1) {
        const r = i + 1;
        if (boundary(i, r)) {
          const above = iy > 0 && mask[i - segX] && mask[r - segX];
          const below = iy < segY - 1 && mask[i + segX] && mask[r + segX];
          if (!above || !below) {
            if (!above) quad(frontIdx[i]!, frontIdx[r]!, backIdx[r]!, backIdx[i]!);
            else quad(frontIdx[r]!, frontIdx[i]!, backIdx[i]!, backIdx[r]!);
          }
        }
      }
      // vertical edge downwards
      if (iy < segY - 1) {
        const dn = i + segX;
        if (boundary(i, dn)) {
          const left = ix > 0 && mask[i - 1] && mask[dn - 1];
          const right = ix < segX - 1 && mask[i + 1] && mask[dn + 1];
          if (!left || !right) {
            if (!left) quad(frontIdx[dn]!, frontIdx[i]!, backIdx[i]!, backIdx[dn]!);
            else quad(frontIdx[i]!, frontIdx[dn]!, backIdx[dn]!, backIdx[i]!);
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.center();

  geo.userData.originalPosition = new Float32Array(geo.attributes.position.array);

  const isFrontAttr = new Uint8Array(positions.length / 3);
  for (let i = 0; i < frontIdx.length; i++) {
    if (frontIdx[i] !== -1) {
      isFrontAttr[frontIdx[i] as number] = 1;
    }
  }
  geo.userData.isFront = isFrontAttr;

  return geo;
}
