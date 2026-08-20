import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import type { DepthResult } from "@/lib/depth";
import type { CutoutResult } from "@/lib/segment";
import type { ViewMode } from "@/components/ModelStage";

const ModelStage = lazy(() => import("@/components/ModelStage"));

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "icon", type: "image/png", href: "/jack.png" }],
    meta: [
      { title: "Jack Mirror — Free Image to 3D Model Generator" },
      {
        name: "description",
        content:
          "Turn any 2D photo into a textured 3D model right in your browser. Free, private, no account — orbit, tweak relief and export GLB.",
      },
      { property: "og:title", content: "Jack Mirror — Free Image to 3D Model Generator" },
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
  const [relief, setRelief] = useState(1.1);
  const [smooth, setSmooth] = useState(3);
  const [thickness, setThickness] = useState(0.7);
  const [removeBg, setRemoveBg] = useState(true);
  const [autoDetect, setAutoDetect] = useState(true);
  const [mode, setMode] = useState<ViewMode>("solid");
  const [spin, setSpin] = useState(true);
  const objectRef = useRef<THREE.Object3D | null>(null);

  const [depthControls, setDepthControls] = useState({
    front: 1.0,
    back: 1.0,
    left: 1.0,
    right: 1.0,
    top: 1.0,
    bottom: 1.0,
  });

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
    setImageUrl(URL.createObjectURL(file));
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
      } else {
        setCutout(null);
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
          <span className="font-display text-[15px] font-semibold tracking-tight">Jack Mirror</span>
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
              min={0.15}
              max={1.5}
              step={0.05}
              onChange={setThickness}
            />
            <div className="pt-2 border-t border-border/60">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Depth Control (Per Side)
              </p>
              <div className="space-y-1">
                <DepthControl label="Front" value={depthControls.front} onChange={v => setDepthControls(d => ({ ...d, front: v }))} />
                <DepthControl label="Back" value={depthControls.back} onChange={v => setDepthControls(d => ({ ...d, back: v }))} />
                <DepthControl label="Left" value={depthControls.left} onChange={v => setDepthControls(d => ({ ...d, left: v }))} />
                <DepthControl label="Right" value={depthControls.right} onChange={v => setDepthControls(d => ({ ...d, right: v }))} />
                <DepthControl label="Top" value={depthControls.top} onChange={v => setDepthControls(d => ({ ...d, top: v }))} />
                <DepthControl label="Bottom" value={depthControls.bottom} onChange={v => setDepthControls(d => ({ ...d, bottom: v }))} />
              </div>
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
                mode={mode}
                spin={spin}
                depthControls={depthControls}
                onObject={onObject}
              />
              <div className="pointer-events-none absolute inset-0 z-10">
                <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2">
                  <OverlayControl label="Top" value={depthControls.top} onChange={(v) => setDepthControls((d) => ({ ...d, top: v }))} />
                </div>
                <div className="pointer-events-auto absolute bottom-12 left-1/2 -translate-x-1/2">
                  <OverlayControl label="Bottom" value={depthControls.bottom} onChange={(v) => setDepthControls((d) => ({ ...d, bottom: v }))} />
                </div>
                <div className="pointer-events-auto absolute left-4 top-1/2 -translate-y-1/2">
                  <OverlayControl label="Left" value={depthControls.left} onChange={(v) => setDepthControls((d) => ({ ...d, left: v }))} />
                </div>
                <div className="pointer-events-auto absolute right-4 top-1/2 -translate-y-1/2">
                  <OverlayControl label="Right" value={depthControls.right} onChange={(v) => setDepthControls((d) => ({ ...d, right: v }))} />
                </div>
                <div className="pointer-events-auto absolute top-4 left-4">
                  <OverlayControl label="Front" value={depthControls.front} onChange={(v) => setDepthControls((d) => ({ ...d, front: v }))} />
                </div>
                <div className="pointer-events-auto absolute top-4 right-4">
                  <OverlayControl label="Back" value={depthControls.back} onChange={(v) => setDepthControls((d) => ({ ...d, back: v }))} />
                </div>
              </div>
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
        <span className="font-mono text-foreground">{value}</span>
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

function DepthControl({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span className="w-12">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(value - 1)}
          className="rounded bg-secondary px-2 py-0.5 transition hover:bg-primary hover:text-primary-foreground"
        >
          −
        </button>
        <input
          type="number"
          step="0.1"
          value={Number(value.toFixed(2))}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-14 bg-transparent text-center font-mono outline-none"
        />
        <button
          onClick={() => onChange(value + 1)}
          className="rounded bg-secondary px-2 py-0.5 transition hover:bg-primary hover:text-primary-foreground"
        >
          +
        </button>
      </div>
    </div>
  );
}

function OverlayControl({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-border bg-card/80 p-1.5 text-[11px] text-muted-foreground backdrop-blur">
      <span className="font-semibold uppercase tracking-widest text-[9px]">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(value - 1)}
          className="rounded bg-secondary px-1.5 py-0.5 transition hover:bg-primary hover:text-primary-foreground"
        >
          −
        </button>
        <input
          type="number"
          step="0.1"
          value={Number(value.toFixed(2))}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-12 bg-transparent text-center font-mono outline-none"
        />
        <button
          onClick={() => onChange(value + 1)}
          className="rounded bg-secondary px-1.5 py-0.5 transition hover:bg-primary hover:text-primary-foreground"
        >
          +
        </button>
      </div>
    </div>
  );
}
