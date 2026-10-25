import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import type { DepthResult } from "@/lib/depth";
import type { CutoutResult } from "@/lib/segment";
import type { ViewMode } from "@/components/ModelStage";
import type { BackMode, EdgeProfile, ResolutionPreset } from "@/lib/mesh";

const ModelStage = lazy(() => import("@/components/ModelStage"));

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "icon", type: "image/png", href: "/jack.png" }],
    meta: [
      { title: "Jack 3D — Free Image to 3D Model Generator" },
      {
        name: "description",
        content:
          "Turn any 2D photo into a textured 3D model right in your browser. Free, private, no account — orbit, tweak relief and export GLB.",
      },
      { property: "og:title", content: "Jack 3D — Free Image to 3D Model Generator" },
      {
        property: "og:description",
        content:
          "Upload a photo and instantly get a textured 3D model you can orbit and export as GLB. Runs entirely in your browser.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Status = "idle" | "loading-model" | "detecting" | "cutting-out" | "generating" | "done" | "error";

function Index() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [depth, setDepth] = useState<DepthResult | null>(null);
  const [cutout, setCutout] = useState<CutoutResult | null>(null);
  const [subject, setSubject] = useState<{ label: string; score: number } | null>(null);
  const [workUrl, setWorkUrl] = useState<string | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [relief, setRelief] = useState(1.45);
  const [smooth, setSmooth] = useState(5);
  const [thickness, setThickness] = useState(0.7);
  const [resolution, setResolution] = useState<ResolutionPreset>("medium");
  const [backMode, setBackMode] = useState<BackMode>("flat");
  const [backColor, setBackColor] = useState<string>("#27272a");
  const [colorSides, setColorSides] = useState<boolean>(false);
  const [sampledSideColor, setSampledSideColor] = useState<string>("#27272a");
  const [edgeProfile, setEdgeProfile] = useState<EdgeProfile>("rounded");
  const [enableNormalMap, setEnableNormalMap] = useState(true);
  const [normalStrength, setNormalStrength] = useState(1.8);
  const [removeBg, setRemoveBg] = useState(true);
  const [autoDetect, setAutoDetect] = useState(true);
  const [mode, setMode] = useState<ViewMode>("solid");
  const [spin, setSpin] = useState(true);
  const objectRef = useRef<THREE.Object3D | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const pickFile = (file: File) => {
    setDepth(null);
    setCutout(null);
    setSubject(null);
    setWorkUrl(null);
    setStatus("idle");
    setError(null);
    setFileName(file.name);
    const url = URL.createObjectURL(file);
    setImageUrl(url);

    import("@/lib/image-utils").then(({ extractEdgeColor }) => {
      extractEdgeColor(url).then((color) => {
        setSampledSideColor(color);
        setBackColor(color);
      });
    });
  };

  const generate = async () => {
    if (!imageUrl) return;
    setError(null);
    setProgress(0);
    setStatus("loading-model");
    try {
      let src = imageUrl;

      if (autoDetect) {
        setStatus("detecting");
        setProgress(0);
        const { detectSubject } = await import("@/lib/detect");
        const found = await detectSubject(imageUrl, (p) => setProgress(p));
        if (found) {
          src = found.url;
          setSubject({ label: found.label, score: found.score });
        } else {
          setSubject(null);
        }
      } else {
        setSubject(null);
      }
      setWorkUrl(src);

      let cut: CutoutResult | null = null;
      if (removeBg) {
        setStatus("cutting-out");
        setProgress(0);
        const { removeBackground } = await import("@/lib/segment");
        cut = await removeBackground(src, (p) => setProgress(p));
        setCutout(cut);

        const { extractEdgeColor } = await import("@/lib/image-utils");
        extractEdgeColor(cut.url).then((edgeColor) => {
          setSampledSideColor(edgeColor);
          setBackColor((prev) =>
            prev === "#27272a" || prev === sampledSideColor ? edgeColor : prev,
          );
        });
      } else {
        setCutout(null);
        const { extractEdgeColor } = await import("@/lib/image-utils");
        extractEdgeColor(src).then((edgeColor) => {
          setSampledSideColor(edgeColor);
          setBackColor((prev) =>
            prev === "#27272a" || prev === sampledSideColor ? edgeColor : prev,
          );
        });
      }

      setStatus("loading-model");
      setProgress(0);
      const { estimateDepth } = await import("@/lib/depth");
      const result = await estimateDepth(cut?.url ?? src, (p) => {
        setProgress(p);
        setStatus("loading-model");
      });
      setStatus("generating");
      setDepth(result);
      setStatus("done");
      setSpin(true);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Generation failed");
      setStatus("error");
    }
  };


  const exportGlb = async () => {
    if (!objectRef.current) return;
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const exporter = new GLTFExporter();
    exporter.parse(
      objectRef.current,
      (gltf) => {
        const blob = new Blob([gltf as ArrayBuffer], { type: "model/gltf-binary" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${fileName.replace(/\.[^.]+$/, "") || "model"}.glb`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      (err) => console.error(err),
      { binary: true },
    );
  };

  const onObject = useCallback((o: THREE.Object3D) => {
    objectRef.current = o;
  }, []);

  const busy =
    status === "loading-model" ||
    status === "generating" ||
    status === "cutting-out" ||
    status === "detecting";


  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <div className="flex items-center gap-2.5">
          <img
            src="/jack.png"
            alt="Jack Logo"
            className="size-7 rounded-md object-cover"
          />
          <span className="font-display text-[15px] font-semibold tracking-tight">Jack 3D</span>
          <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Free · runs on your device
          </span>
        </div>
        <button
          onClick={exportGlb}
          disabled={!depth}
          className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
        >
          Export .GLB
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        {/* Left panel */}
        <aside className="flex w-full md:w-[280px] shrink-0 flex-col gap-5 overflow-visible md:overflow-y-auto border-b md:border-b-0 md:border-r border-border p-4">
          <div>
            <h1 className="font-display text-sm font-semibold">Generate model</h1>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Drop a photo. A depth model reconstructs its geometry and wraps the original pixels
              back on as texture — so shape and color match the source.
            </p>
          </div>



          <div className="space-y-4 rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Geometry
            </p>
            <Slider
              label="Relief depth"
              value={relief}
              min={0.2}
              max={2.5}
              step={0.05}
              onChange={setRelief}
            />
            <Slider
              label="Surface smoothing"
              value={smooth}
              min={0}
              max={6}
              step={1}
              onChange={setSmooth}
            />
            <Slider
              label="Solid thickness"
              value={thickness}
              min={0.0}
              max={1.5}
              step={0.05}
              onChange={setThickness}
            />

            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">Mesh Resolution</p>
              <div className="grid grid-cols-4 gap-1 rounded-md bg-secondary p-1">
                {[
                  { id: "low", label: "Fast" },
                  { id: "medium", label: "Med" },
                  { id: "high", label: "High" },
                  { id: "ultra", label: "Ultra" },
                ].map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setResolution(r.id as ResolutionPreset)}
                    className={`rounded px-1.5 py-1 text-[11px] font-medium transition ${
                      resolution === r.id
                        ? "bg-primary font-semibold text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">Edge Silhouette</p>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-secondary p-1">
                {[
                  { id: "rounded", label: "Dome" },
                  { id: "sharp", label: "Sharp" },
                  { id: "chamfer", label: "Chamfer" },
                ].map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setEdgeProfile(e.id as EdgeProfile)}
                    className={`rounded px-1.5 py-1 text-[11px] font-medium transition ${
                      edgeProfile === e.id
                        ? "bg-primary font-semibold text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">Back-side Shape</p>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-secondary p-1">
                {[
                  {
                    id: "flat",
                    label: "Flat Back",
                    sub: "Organic curved back with side color",
                  },
                  {
                    id: "mirrored",
                    label: "Mirror Front",
                    sub: "Mirror front side to back",
                  },
                ].map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setBackMode(b.id as BackMode)}
                    className={`rounded px-2 py-1.5 text-left transition ${
                      backMode === b.id
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-background/40"
                    }`}
                  >
                    <div className="text-[11px] font-semibold">{b.label}</div>
                    <div
                      className={`text-[9px] ${
                        backMode === b.id
                          ? "text-primary-foreground/85"
                          : "text-muted-foreground"
                      }`}
                    >
                      {b.sub}
                    </div>
                  </button>
                ))}
              </div>

              {backMode === "flat" && (
                <div className="mt-2 space-y-2 rounded-lg border border-border/70 bg-card/60 p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">Back & Side Color</span>
                    <span className="font-mono text-[10px] text-muted-foreground uppercase">{backColor}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Sampled Side Color */}
                    <button
                      type="button"
                      title={`Sampled Edge/Side Color (${sampledSideColor})`}
                      onClick={() => setBackColor(sampledSideColor)}
                      className={`relative flex size-6 items-center justify-center rounded-full border transition ${
                        backColor.toLowerCase() === sampledSideColor.toLowerCase()
                          ? "border-primary ring-2 ring-primary/40 scale-110"
                          : "border-border hover:scale-105"
                      }`}
                      style={{ backgroundColor: sampledSideColor }}
                    >
                      <span className="text-[9px] font-bold text-white drop-shadow">A</span>
                    </button>

                    {/* Presets */}
                    {[
                      { name: "Dark Slate", hex: "#18181b" },
                      { name: "Charcoal", hex: "#334155" },
                      { name: "Warm Clay", hex: "#78350f" },
                      { name: "Brass / Gold", hex: "#b45309" },
                      { name: "Ceramic White", hex: "#f8fafc" },
                    ].map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        title={c.name}
                        onClick={() => setBackColor(c.hex)}
                        className={`size-6 rounded-full border transition ${
                          backColor.toLowerCase() === c.hex.toLowerCase()
                            ? "border-primary ring-2 ring-primary/40 scale-110"
                            : "border-border hover:scale-105"
                        }`}
                        style={{ backgroundColor: c.hex }}
                      />
                    ))}

                    {/* Custom Color Picker */}
                    <label
                      title="Custom color (or anything)"
                      className="relative flex size-6 cursor-pointer items-center justify-center rounded-full border border-border bg-gradient-to-tr from-indigo-500 via-rose-500 to-amber-400 hover:scale-105 transition"
                    >
                      <input
                        type="color"
                        value={backColor}
                        onChange={(e) => setBackColor(e.target.value)}
                        className="sr-only"
                      />
                    </label>
                  </div>

                  <label className="flex items-center justify-between pt-0.5 text-[11px] text-muted-foreground cursor-pointer">
                    <span>Apply color to rim sides</span>
                    <input
                      type="checkbox"
                      checked={colorSides}
                      onChange={(e) => setColorSides(e.target.checked)}
                      className="accent-primary"
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-border/60 space-y-2">
              <label className="flex items-center justify-between text-xs text-muted-foreground cursor-pointer">
                <span>Surface micro-relief</span>
                <input
                  type="checkbox"
                  checked={enableNormalMap}
                  onChange={(e) => setEnableNormalMap(e.target.checked)}
                  className="accent-primary"
                />
              </label>
              {enableNormalMap && (
                <Slider
                  label="Micro-relief intensity"
                  value={normalStrength}
                  min={0.5}
                  max={3.0}
                  step={0.1}
                  onChange={setNormalStrength}
                />
              )}
            </div>

            <label className="flex items-center justify-between text-xs text-muted-foreground">
              AI object detection
              <input
                type="checkbox"
                checked={autoDetect}
                onChange={(e) => setAutoDetect(e.target.checked)}
                className="accent-primary"
              />
            </label>
            <label className="flex items-center justify-between text-xs text-muted-foreground">
              Remove background
              <input
                type="checkbox"
                checked={removeBg}
                onChange={(e) => setRemoveBg(e.target.checked)}
                className="accent-primary"
              />
            </label>

            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">Shading</p>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-secondary p-1">
                {(["solid", "wireframe", "points"] as ViewMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded px-2 py-1 text-[11px] capitalize transition ${
                      mode === m
                        ? "bg-primary font-semibold text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between text-xs text-muted-foreground">
              Auto-rotate
              <input
                type="checkbox"
                checked={spin}
                onChange={(e) => setSpin(e.target.checked)}
                className="accent-primary"
              />
            </label>
          </div>

          <button
            onClick={generate}
            disabled={!imageUrl || busy}
            className="w-full rounded-md bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {busy ? "Generating…" : "Generate 3D Model"}
          </button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </aside>

        {/* Viewport */}
        <main className="relative w-full min-h-[50vh] md:min-h-0 min-w-0 flex-1 bg-[#0b0d10]">
          {depth && imageUrl ? (
            <Suspense fallback={<Centered>Loading viewport…</Centered>}>
              <ModelStage
                depth={depth}
                cutout={cutout}
                imageUrl={workUrl ?? imageUrl}
                relief={relief}
                smooth={smooth}
                thickness={thickness}
                resolution={resolution}
                backMode={backMode}
                backColor={backColor}
                colorSides={colorSides}
                edgeProfile={edgeProfile}
                enableNormalMap={enableNormalMap}
                normalStrength={normalStrength}
                mode={mode}
                spin={spin}
                onObject={onObject}
              />
            </Suspense>
          ) : busy ? (
            <Centered>
              <div className="w-64 text-center">
                <div className="mx-auto mb-4 size-10 animate-spin rounded-full border-2 border-border border-t-primary" />
                <p className="font-display text-sm">
                  {status === "detecting"
                    ? "Detecting the object…"
                    : status === "cutting-out"
                      ? "Removing background…"
                      : status === "loading-model"
                        ? "Preparing AI model…"
                        : "Reconstructing geometry…"}

                </p>
                <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${status === "generating" ? 100 : progress}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  First run downloads the model once, then it&apos;s cached.
                </p>
              </div>
            </Centered>
          ) : (
            <Centered>
              <div className="text-center">
                <p className="font-display text-2xl font-semibold text-muted-foreground">
                  Ready for a new 3D model?
                </p>
                <p className="mt-2 text-sm text-muted-foreground/70">
                  Instantly generate 3D from an image — free, private, in your browser.
                </p>
              </div>
            </Centered>
          )}

          {depth && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/80 px-4 py-1.5 text-[11px] text-muted-foreground backdrop-blur">
              Drag to orbit · scroll to zoom · right-drag to pan
            </div>
          )}
        </main>

        {/* Right panel */}
        <aside className="flex w-full md:w-[220px] shrink-0 flex-col gap-3 border-t md:border-t-0 md:border-l border-border p-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Asset
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFile(f);
            }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) pickFile(f);
            }}
            className="group relative aspect-square w-full overflow-hidden rounded-lg border border-dashed border-border bg-card transition hover:border-primary"
          >
            {imageUrl ? (
              <img src={imageUrl} alt="Uploaded source" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center px-4 text-center text-[11px] text-muted-foreground">
                Click or drop an image
              </span>
            )}
          </button>
          <dl className="space-y-1.5 text-[11px]">
            <Row k="Status" v={status === "done" ? "Ready" : busy ? "Working" : "Idle"} />
            <Row
              k="Depth map"
              v={depth ? `${depth.width}×${depth.height}` : "—"}
            />
            <Row
              k="Detected"
              v={subject ? `${subject.label} · ${Math.round(subject.score * 100)}%` : "—"}
            />
            <Row k="Texture" v={imageUrl ? "Source image" : "—"} />
            <Row
              k="Resolution"
              v={
                resolution === "ultra"
                  ? "720 grid (Ultra HD)"
                  : resolution === "high"
                    ? "512 grid (High)"
                    : resolution === "low"
                      ? "180 grid (Fast)"
                      : "360 grid (Standard)"
              }
            />
            <Row k="Edge Seam" v="Split normals (crisp)" />
            <Row
              k="Micro-relief"
              v={enableNormalMap ? `Active (${normalStrength.toFixed(1)}×)` : "Disabled"}
            />
            <Row
              k="Back shape"
              v={
                backMode === "flat"
                  ? "Flat Base (Solid back)"
                  : "Mirrored 3D (Front-to-back)"
              }
            />
            {backMode === "flat" && (
              <Row
                k="Back color"
                v={
                  backColor.toLowerCase() === sampledSideColor.toLowerCase()
                    ? `Auto Side (${backColor})`
                    : backColor
                }
              />
            )}
            <Row k="Format" v="GLB / glTF 2.0" />
          </dl>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-border/60 pb-1.5">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="truncate font-medium">{v}</dd>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid size-full place-items-center p-6">{children}</div>;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-muted-foreground">
        {label}
        <span className="font-mono text-foreground">
          {Number.isInteger(step) ? value : value.toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </label>
  );
}


