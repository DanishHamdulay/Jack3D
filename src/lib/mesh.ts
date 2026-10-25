import * as THREE from "three";
import type { DepthResult } from "@/lib/depth";
import type { CutoutResult } from "@/lib/segment";

export type BackMode = "mirrored" | "flat" | "hollow";
export type EdgeProfile = "rounded" | "sharp" | "chamfer";
export type ResolutionPreset = "low" | "medium" | "high" | "ultra";

export type MeshOptions = {
  relief: number;
  smooth: number;
  /** 0..1 — how thick the back shell is relative to relief */
  thickness: number;
  resolution?: ResolutionPreset;
  backMode?: BackMode;
  edgeProfile?: EdgeProfile;
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
 * Builds a closed, watertight solid with sharp split-normal silhouette seams:
 * - Displaced front relief surface
 * - Configurable back geometry (mirrored inflated shell, flat printing base, or hollow shell)
 * - Clean rim skirt with decoupled normals preventing dark edge shading
 * - Edge profile options (rounded dome, sharp vertical extrusion, or linear chamfer)
 * - Multi-resolution mesh grid support (Low 180, Medium 360, High 512, Ultra 720)
 */
export function buildSolidGeometry(
  depth: DepthResult,
  cutout: CutoutResult | null,
  {
    relief,
    smooth,
    thickness,
    resolution = "medium",
    backMode = "mirrored",
    edgeProfile = "rounded",
  }: MeshOptions,
) {
  const aspect = depth.width / depth.height;

  // Grid resolution based on preset
  let targetX = 360;
  if (resolution === "low") targetX = 180;
  else if (resolution === "high") targetX = 512;
  else if (resolution === "ultra") targetX = 720;
  else targetX = 360;

  const segX = Math.max(48, Math.round(targetX));
  const segY = Math.max(32, Math.round(segX / aspect));

  const planeW = aspect >= 1 ? 3 : 3 * aspect;
  const planeH = aspect >= 1 ? 3 / aspect : 3;

  // Sample depth + mask onto the grid
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

  // Erode one ring so the silhouette has no stray speckles
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

  // Surface smoothing passes (masked)
  const tmp = new Float32Array(n);
  const smoothPasses = Math.round(smooth) + 2;
  for (let p = 0; p < smoothPasses; p++) {
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

  // Edge taper calculation based on selected edge profile
  const edgeFade = new Float32Array(n).fill(1);
  if (cutout) {
    if (edgeProfile === "sharp") {
      // Crisp 90-degree vertical drop-off at perimeter, zero taper
      for (let i = 0; i < n; i++) {
        edgeFade[i] = mask[i] ? 1 : 0;
      }
    } else {
      const isChamfer = edgeProfile === "chamfer";
      const STEP = isChamfer ? 0.22 : 0.14;
      const passes = isChamfer ? 5 : 8;

      for (let pass = 0; pass < passes; pass++) {
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

      if (edgeProfile === "rounded") {
        // Dome curvature shoulder
        for (let i = 0; i < n; i++) {
          const t = edgeFade[i] ?? 1;
          edgeFade[i] = Math.sqrt(Math.max(0, Math.min(1, t)));
        }
      }
    }
  }

  // Macro shape: 14 passes of masked averaging to extract low-frequency baseline shape/tilt
  const macro = new Float32Array(dvals);
  const macroTmp = new Float32Array(n);
  for (let p = 0; p < 14; p++) {
    for (let iy = 0; iy < segY; iy++) {
      for (let ix = 0; ix < segX; ix++) {
        const i = iy * segX + ix;
        if (!mask[i]) {
          macroTmp[i] = macro[i] ?? 0;
          continue;
        }
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = ix + dx;
            const ny = iy + dy;
            if (nx < 0 || ny < 0 || nx >= segX || ny >= segY) continue;
            const j = ny * segX + nx;
            if (!mask[j]) continue;
            sum += macro[j] ?? 0;
            cnt++;
          }
        }
        macroTmp[i] = cnt ? sum / cnt : (macro[i] ?? 0);
      }
    }
    macro.set(macroTmp);
  }

  // Micro-relief: high-frequency details (facial features, wrinkles, cloth texture)
  const microRelief = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    microRelief[i] = (dvals[i] ?? 0) - (macro[i] ?? 0);
  }

  // Normalized distance field & circular volume field computation
  const circularField = new Float32Array(n);
  const smoothDist = new Float32Array(n);
  {
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      dist[i] = mask[i] ? 1e6 : 0;
    }

    if (!cutout) {
      for (let iy = 0; iy < segY; iy++) {
        dist[iy * segX] = 0;
        dist[iy * segX + (segX - 1)] = 0;
      }
      for (let ix = 0; ix < segX; ix++) {
        dist[ix] = 0;
        dist[(segY - 1) * segX + ix] = 0;
      }
    }

    const D1 = 1.0;
    const D2 = 1.414;

    // Forward pass: compute distance to boundary
    for (let iy = 0; iy < segY; iy++) {
      for (let ix = 0; ix < segX; ix++) {
        const i = iy * segX + ix;
        if (dist[i] === 0) continue;
        let d = dist[i]!;
        if (ix > 0) d = Math.min(d, dist[i - 1]! + D1);
        if (iy > 0) {
          d = Math.min(d, dist[i - segX]! + D1);
          if (ix > 0) d = Math.min(d, dist[i - segX - 1]! + D2);
          if (ix < segX - 1) d = Math.min(d, dist[i - segX + 1]! + D2);
        }
        dist[i] = d;
      }
    }

    // Backward pass
    for (let iy = segY - 1; iy >= 0; iy--) {
      for (let ix = segX - 1; ix >= 0; ix--) {
        const i = iy * segX + ix;
        if (dist[i] === 0) continue;
        let d = dist[i]!;
        if (ix < segX - 1) d = Math.min(d, dist[i + 1]! + D1);
        if (iy < segY - 1) {
          d = Math.min(d, dist[i + segX]! + D1);
          if (ix < segX - 1) d = Math.min(d, dist[i + segX + 1]! + D2);
          if (ix > 0) d = Math.min(d, dist[i + segX - 1]! + D2);
        }
        dist[i] = d;
      }
    }

    let maxD = 0;
    for (let i = 0; i < n; i++) {
      if (dist[i]! > maxD) maxD = dist[i]!;
    }
    if (maxD < 1) maxD = 1;

    // Smooth normalized distance field [0, 1] for JackAI organic reconstruction
    const normDist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      normDist[i] = (dist[i] ?? 0) / maxD;
    }
    smoothDist.set(normDist);

    const distTmp = new Float32Array(n);
    for (let p = 0; p < 3; p++) {
      for (let iy = 0; iy < segY; iy++) {
        for (let ix = 0; ix < segX; ix++) {
          const i = iy * segX + ix;
          if (!mask[i]) {
            distTmp[i] = 0;
            continue;
          }
          let sum = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = ix + dx;
              const ny = iy + dy;
              if (nx < 0 || ny < 0 || nx >= segX || ny >= segY) continue;
              const j = ny * segX + nx;
              if (!mask[j]) continue;
              sum += smoothDist[j] ?? 0;
              cnt++;
            }
          }
          distTmp[i] = cnt ? sum / cnt : (smoothDist[i] ?? 0);
        }
      }
      smoothDist.set(distTmp);
    }
  }

  // True 3D radial/cylindrical revolution field for Mirrored Mode:
  // Analyzes local horizontal and vertical cross-sections so objects (bottles, vases, characters)
  // produce a mathematically true, seamless circular 360° cross-section without flat plateaus or rim seams.
  const mirrorDepth = new Float32Array(n);
  const mirrorProf = new Float32Array(n);
  {
    const dxWorld = planeW / (segX - 1);
    const dyWorld = planeH / (segY - 1);

    const profX = new Float32Array(n);
    const radWorldX = new Float32Array(n);
    for (let iy = 0; iy < segY; iy++) {
      let inRun = false, start = 0;
      for (let ix = 0; ix < segX; ix++) {
        const i = iy * segX + ix;
        if (mask[i]) {
          if (!inRun) { inRun = true; start = ix; }
        } else {
          if (inRun) {
            inRun = false;
            const wPx = (ix - 1) - start;
            const rPx = wPx / 2;
            const cx = (start + (ix - 1)) / 2;
            const rW = rPx * dxWorld;
            for (let k = start; k < ix; k++) {
              const u = rPx > 0 ? (k - cx) / rPx : 0;
              profX[iy * segX + k] = Math.sqrt(Math.max(0, 1 - u * u));
              radWorldX[iy * segX + k] = rW;
            }
          }
        }
      }
      if (inRun) {
        const wPx = (segX - 1) - start;
        const rPx = wPx / 2;
        const cx = (start + (segX - 1)) / 2;
        const rW = rPx * dxWorld;
        for (let k = start; k < segX; k++) {
          const u = rPx > 0 ? (k - cx) / rPx : 0;
          profX[iy * segX + k] = Math.sqrt(Math.max(0, 1 - u * u));
          radWorldX[iy * segX + k] = rW;
        }
      }
    }

    const profY = new Float32Array(n);
    const radWorldY = new Float32Array(n);
    for (let ix = 0; ix < segX; ix++) {
      let inRun = false, start = 0;
      for (let iy = 0; iy < segY; iy++) {
        const i = iy * segX + ix;
        if (mask[i]) {
          if (!inRun) { inRun = true; start = iy; }
        } else {
          if (inRun) {
            inRun = false;
            const hPx = (iy - 1) - start;
            const rPx = hPx / 2;
            const cy = (start + (iy - 1)) / 2;
            const rW = rPx * dyWorld;
            for (let k = start; k < iy; k++) {
              const u = rPx > 0 ? (k - cy) / rPx : 0;
              profY[k * segX + ix] = Math.sqrt(Math.max(0, 1 - u * u));
              radWorldY[k * segX + ix] = rW;
            }
          }
        }
      }
      if (inRun) {
        const hPx = (segY - 1) - start;
        const rPx = hPx / 2;
        const cy = (start + (segY - 1)) / 2;
        const rW = rPx * dyWorld;
        for (let k = start; k < segY; k++) {
          const u = rPx > 0 ? (k - cy) / rPx : 0;
          profY[k * segX + ix] = Math.sqrt(Math.max(0, 1 - u * u));
          radWorldY[k * segX + ix] = rW;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const rx = radWorldX[i] ?? 0;
      const ry = radWorldY[i] ?? 0;
      const px = profX[i] ?? 0;
      const py = profY[i] ?? 0;
      // For vertical objects (bottles, people), rx < ry, so cross-section radius is rx.
      // For horizontal objects, ry < rx, so cross-section radius is ry.
      const baseR = (rx > 0 && ry > 0) ? Math.min(rx, ry) : Math.max(rx, ry);
      const profile = Math.min(px, py);
      mirrorDepth[i] = baseR * profile;
      mirrorProf[i] = profile;
    }

    // Two passes of masked box blur on mirrorDepth for butter-smooth curvature
    const smoothDepthTmp = new Float32Array(n);
    for (let p = 0; p < 2; p++) {
      for (let iy = 0; iy < segY; iy++) {
        for (let ix = 0; ix < segX; ix++) {
          const i = iy * segX + ix;
          if (!mask[i]) {
            smoothDepthTmp[i] = 0;
            continue;
          }
          let sum = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = ix + dx;
              const ny = iy + dy;
              if (nx < 0 || ny < 0 || nx >= segX || ny >= segY) continue;
              const j = ny * segX + nx;
              if (!mask[j]) continue;
              sum += mirrorDepth[j] ?? 0;
              cnt++;
            }
          }
          smoothDepthTmp[i] = cnt ? sum / cnt : (mirrorDepth[i] ?? 0);
        }
      }
      mirrorDepth.set(smoothDepthTmp);
    }
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const frontIdx = new Int32Array(n).fill(-1);
  const backIdx = new Int32Array(n).fill(-1);

  // Store coordinates for rim vertex cloning (split normals)
  const frontCoord = new Float32Array(n * 3);
  const backCoord = new Float32Array(n * 3);
  const uvCoord = new Float32Array(n * 2);

  const px = (ix: number) => (ix / (segX - 1) - 0.5) * planeW;
  const py = (iy: number) => (0.5 - iy / (segY - 1)) * planeH;

  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const i = iy * segX + ix;
      if (!mask[i]) continue;

      const fade = edgeFade[i] ?? 1;
      const x = px(ix);
      const y = py(iy);
      const u = ix / (segX - 1);
      const v = 1 - iy / (segY - 1);

      uvCoord[i * 2] = u;
      uvCoord[i * 2 + 1] = v;

      // Z calculation based on backMode
      let fz = 0;
      let bz = 0;

      if (backMode === "flat") {
        // JackAI volumetric reconstruction algorithm (from jackaizgen.vercel.app):
        // Back side has an organic convex backing derived from distance transform
        // so it is NOT completely flat, while front side preserves full micro-relief.
        const s = 0.40 + thickness * 0.65;
        const b = 0.34 * s;
        const t = (macro[i] ?? 0.5) - 0.5;
        const normD = smoothDist[i] ?? 0;

        // Convex volume radius derived from silhouette distance
        const r = b * Math.sqrt(Math.max(0, normD)) * (0.62 + 0.38 * (0.5 + t));

        // Midplane tilt
        const midI = t * 0.42 * s;

        // Micro-relief: high-frequency detail tapered at the silhouette rim
        const microScale = Math.min(1, r / (b * 0.5 + 1e-6));
        const micro = (microRelief[i] ?? 0) * relief * 0.9 * microScale;

        // Crisp separation between front and back at boundary for clean rim geometry
        const rimHalf = (0.002 + thickness * 0.03) * fade;

        fz = midI + r + micro + rimHalf;
        bz = midI - r - rimHalf;
      } else if (backMode === "hollow") {
        const rawD = (dvals[i] ?? 0.5) - 0.5;
        const d = rawD * relief * fade;
        fz = d + 0.001 * fade;
        bz = d - relief * Math.max(0, thickness * 0.35) * fade - 0.002 * fade;
      } else {
        // Mirrored 3D: True radial / cylindrical revolution
        // Produces a perfect 360° circular cross-section matching the physical object (e.g. bottle, vase)
        const depthScale = Math.max(0.1, thickness * 1.4);
        const baseZ = mirrorDepth[i]! * depthScale;
        const prof = mirrorProf[i] ?? 0;
        const micro = (microRelief[i] ?? 0) * relief * 0.35 * prof;
        const eps = 0.0005 * prof;

        fz = baseZ + micro + eps;
        bz = -baseZ - micro - eps;
      }

      // Front vertex
      frontCoord[i * 3] = x;
      frontCoord[i * 3 + 1] = y;
      frontCoord[i * 3 + 2] = fz;

      frontIdx[i] = positions.length / 3;
      positions.push(x, y, fz);
      uvs.push(u, v);

      // Back vertex
      backCoord[i * 3] = x;
      backCoord[i * 3 + 1] = y;
      backCoord[i * 3 + 2] = bz;

      backIdx[i] = positions.length / 3;
      positions.push(x, y, bz);
      uvs.push(u, v);
    }
  }

  const quad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d);
  };

  // 1. Build front surface mesh (Group 0)
  const frontStart = indices.length;
  for (let iy = 0; iy < segY - 1; iy++) {
    for (let ix = 0; ix < segX - 1; ix++) {
      const i00 = iy * segX + ix;
      const i10 = iy * segX + ix + 1;
      const i01 = (iy + 1) * segX + ix;
      const i11 = (iy + 1) * segX + ix + 1;
      if (!mask[i00] || !mask[i10] || !mask[i01] || !mask[i11]) continue;

      // Front faces (CCW facing +Z)
      quad(frontIdx[i00]!, frontIdx[i01]!, frontIdx[i11]!, frontIdx[i10]!);
    }
  }
  const frontCount = indices.length - frontStart;

  // 2. Build back surface mesh (Group 1)
  const backStart = indices.length;
  for (let iy = 0; iy < segY - 1; iy++) {
    for (let ix = 0; ix < segX - 1; ix++) {
      const i00 = iy * segX + ix;
      const i10 = iy * segX + ix + 1;
      const i01 = (iy + 1) * segX + ix;
      const i11 = (iy + 1) * segX + ix + 1;
      if (!mask[i00] || !mask[i10] || !mask[i01] || !mask[i11]) continue;

      // Back faces (reversed, facing -Z)
      quad(backIdx[i00]!, backIdx[i10]!, backIdx[i11]!, backIdx[i01]!);
    }
  }
  const backCount = indices.length - backStart;

  // 3. Rim skirt joining front & back along silhouette boundary (Group 2)
  const rimStart = indices.length;

  // Rim skirt joining front & back along silhouette boundary.
  // CRITICAL: We duplicate the boundary vertices for the rim!
  // This produces sharp split normals along the perimeter seam, eliminating
  // dark shadow smearing around the model edges when computing normals.
  const boundary = (a: number, b: number) => {
    return !!(mask[a] && mask[b]);
  };

  const addRimQuad = (
    iA: number,
    iB: number,
    flipWinding: boolean,
  ) => {
    const idxStart = positions.length / 3;

    const uA = uvCoord[iA * 2]!;
    const vA = uvCoord[iA * 2 + 1]!;
    const uB = uvCoord[iB * 2]!;
    const vB = uvCoord[iB * 2 + 1]!;

    // 0: Front A
    positions.push(frontCoord[iA * 3]!, frontCoord[iA * 3 + 1]!, frontCoord[iA * 3 + 2]!);
    uvs.push(uA, vA);

    // 1: Front B
    positions.push(frontCoord[iB * 3]!, frontCoord[iB * 3 + 1]!, frontCoord[iB * 3 + 2]!);
    uvs.push(uB, vB);

    // 2: Back B
    positions.push(backCoord[iB * 3]!, backCoord[iB * 3 + 1]!, backCoord[iB * 3 + 2]!);
    uvs.push(uB, vB);

    // 3: Back A
    positions.push(backCoord[iA * 3]!, backCoord[iA * 3 + 1]!, backCoord[iA * 3 + 2]!);
    uvs.push(uA, vA);

    if (!flipWinding) {
      quad(idxStart, idxStart + 1, idxStart + 2, idxStart + 3);
    } else {
      quad(idxStart + 1, idxStart, idxStart + 3, idxStart + 2);
    }
  };

  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const i = iy * segX + ix;
      if (!mask[i]) continue;

      // Horizontal edge to the right
      if (ix < segX - 1) {
        const r = i + 1;
        if (boundary(i, r)) {
          const above = iy > 0 && mask[i - segX] && mask[r - segX];
          const below = iy < segY - 1 && mask[i + segX] && mask[r + segX];
          if (!above || !below) {
            addRimQuad(i, r, !!above);
          }
        }
      }

      // Vertical edge downwards
      if (iy < segY - 1) {
        const dn = i + segX;
        if (boundary(i, dn)) {
          const left = ix > 0 && mask[i - 1] && mask[dn - 1];
          const right = ix < segX - 1 && mask[i + 1] && mask[dn + 1];
          if (!left || !right) {
            addRimQuad(dn, i, !!left);
          }
        }
      }
    }
  }
  const rimCount = indices.length - rimStart;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.clearGroups();
  geo.addGroup(frontStart, frontCount, 0);
  geo.addGroup(backStart, backCount, 1);
  geo.addGroup(rimStart, rimCount, 2);
  geo.computeVertexNormals();

  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const centerX = (box.min.x + box.max.x) / 2;
  const centerY = (box.min.y + box.max.y) / 2;

  const centerZ = (box.min.z + box.max.z) / 2;
  geo.translate(-centerX, -centerY, -centerZ);

  return geo;
}
