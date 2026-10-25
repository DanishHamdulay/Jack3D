import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { DepthResult } from "@/lib/depth";
import type { CutoutResult } from "@/lib/segment";
import {
  buildSolidGeometry,
  type BackMode,
  type EdgeProfile,
  type ResolutionPreset,
} from "@/lib/mesh";
import { createNormalMapFromImage } from "@/lib/normalMap";

export type ViewMode = "solid" | "wireframe" | "points";

function Model({
  depth,
  cutout,
  texture,
  normalTexture,
  enableNormalMap,
  normalStrength,
  relief,
  smooth,
  thickness,
  resolution,
  backMode,
  backColor = "#27272a",
  colorSides = false,
  edgeProfile,
  mode,
  spin,
  onReady,
}: {
  depth: DepthResult;
  cutout: CutoutResult | null;
  texture: THREE.Texture;
  normalTexture: THREE.CanvasTexture | null;
  enableNormalMap: boolean;
  normalStrength: number;
  relief: number;
  smooth: number;
  thickness: number;
  resolution: ResolutionPreset;
  backMode: BackMode;
  backColor?: string;
  colorSides?: boolean;
  edgeProfile: EdgeProfile;
  mode: ViewMode;
  spin: boolean;
  onReady: (o: THREE.Object3D) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const geo = useMemo(
    () =>
      buildSolidGeometry(depth, cutout, {
        relief,
        smooth,
        thickness,
        resolution,
        backMode,
        edgeProfile,
      }),
    [depth, cutout, relief, smooth, thickness, resolution, backMode, edgeProfile],
  );

  const normalScaleVec = useMemo(
    () => new THREE.Vector2(normalStrength, normalStrength),
    [normalStrength],
  );

  const frontMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      map: texture,
      normalMap: enableNormalMap && normalTexture ? normalTexture : null,
      normalScale: enableNormalMap && normalTexture ? normalScaleVec : undefined,
      roughness: 0.65,
      metalness: 0.06,
      transparent: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      wireframe: mode === "wireframe",
    });
  }, [texture, normalTexture, enableNormalMap, normalScaleVec, mode]);

  const backMaterial = useMemo(() => {
    if (backMode === "flat") {
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(backColor),
        roughness: 0.65,
        metalness: 0.08,
        side: THREE.DoubleSide,
        wireframe: mode === "wireframe",
      });
    }
    // Mirrored / 3D mode: uses front texture and normal map
    return new THREE.MeshStandardMaterial({
      map: texture,
      normalMap: enableNormalMap && normalTexture ? normalTexture : null,
      normalScale: enableNormalMap && normalTexture ? normalScaleVec : undefined,
      roughness: 0.65,
      metalness: 0.06,
      transparent: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      wireframe: mode === "wireframe",
    });
  }, [backMode, backColor, texture, normalTexture, enableNormalMap, normalScaleVec, mode]);

  const rimMaterial = useMemo(() => {
    if (backMode === "flat" && colorSides) {
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(backColor),
        roughness: 0.65,
        metalness: 0.08,
        side: THREE.DoubleSide,
        wireframe: mode === "wireframe",
      });
    }
    return new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.65,
      metalness: 0.06,
      transparent: true,
      alphaTest: 0.2,
      side: THREE.DoubleSide,
      wireframe: mode === "wireframe",
    });
  }, [backMode, colorSides, backColor, texture, mode]);

  const materials = useMemo(
    () => [frontMaterial, backMaterial, rimMaterial],
    [frontMaterial, backMaterial, rimMaterial],
  );

  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => {
    return () => {
      frontMaterial.dispose();
      backMaterial.dispose();
      rimMaterial.dispose();
    };
  }, [frontMaterial, backMaterial, rimMaterial]);

  useEffect(() => {
    if (group.current) onReady(group.current);
  }, [geo, mode, onReady, normalTexture, enableNormalMap, materials]);

  useFrame((_, dt) => {
    if (spin && group.current) group.current.rotation.y += dt * 0.5;
  });

  return (
    <group ref={group}>
      {mode === "points" ? (
        <points geometry={geo}>
          <pointsMaterial size={0.012} map={texture} transparent alphaTest={0.5} sizeAttenuation />
        </points>
      ) : (
        <mesh geometry={geo} material={materials} castShadow receiveShadow />
      )}
    </group>
  );
}

function Rig() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, 0, 4.2);
  }, [camera]);
  return null;
}

export default function ModelStage({
  depth,
  cutout,
  imageUrl,
  relief,
  smooth,
  thickness,
  resolution = "medium",
  backMode = "mirrored",
  backColor = "#27272a",
  colorSides = false,
  edgeProfile = "rounded",
  enableNormalMap = true,
  normalStrength = 1.8,
  mode,
  spin,
  onObject,
}: {
  depth: DepthResult;
  cutout: CutoutResult | null;
  imageUrl: string;
  relief: number;
  smooth: number;
  thickness: number;
  resolution?: ResolutionPreset;
  backMode?: BackMode;
  backColor?: string;
  colorSides?: boolean;
  edgeProfile?: EdgeProfile;
  enableNormalMap?: boolean;
  normalStrength?: number;
  mode: ViewMode;
  spin: boolean;
  onObject: (o: THREE.Object3D) => void;
}) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [normalTexture, setNormalTexture] = useState<THREE.CanvasTexture | null>(null);
  const src = cutout?.url ?? imageUrl;

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    let isCurrent = true;
    loader.load(src, (t) => {
      if (isCurrent) {
        t.colorSpace = THREE.SRGBColorSpace;
        setTexture(t);
      } else {
        t.dispose();
      }
    });
    return () => {
      isCurrent = false;
    };
  }, [src]);

  useEffect(() => {
    let isCurrent = true;
    if (!enableNormalMap || !src) {
      setNormalTexture(null);
      return;
    }

    createNormalMapFromImage(src, normalStrength)
      .then((t) => {
        if (isCurrent) {
          setNormalTexture((prev) => {
            if (prev) prev.dispose();
            return t;
          });
        } else {
          t.dispose();
        }
      })
      .catch((err) => {
        console.warn("Failed to generate normal map", err);
      });

    return () => {
      isCurrent = false;
    };
  }, [src, enableNormalMap, normalStrength]);

  useEffect(() => {
    return () => {
      if (normalTexture) normalTexture.dispose();
      if (texture) texture.dispose();
    };
  }, [normalTexture, texture]);

  if (!texture) return null;

  return (
    <Canvas dpr={[1, 2]} shadows camera={{ fov: 42 }} gl={{ antialias: true }}>
      <color attach="background" args={["#0b0d10"]} />
      <Rig />
      <ambientLight intensity={0.75} />
      <directionalLight position={[3, 4, 5]} intensity={1.6} castShadow />
      <directionalLight position={[-4, -1, -3]} intensity={0.7} />
      <Environment preset="city" />
      <Model
        depth={depth}
        cutout={cutout}
        texture={texture}
        normalTexture={normalTexture}
        enableNormalMap={enableNormalMap}
        normalStrength={normalStrength}
        relief={relief}
        smooth={smooth}
        thickness={thickness}
        resolution={resolution}
        backMode={backMode}
        backColor={backColor}
        colorSides={colorSides}
        edgeProfile={edgeProfile}
        mode={mode}
        spin={spin}
        onReady={onObject}
      />
      <ContactShadows position={[0, -1.8, 0]} opacity={0.3} blur={2.6} far={4} />
      <OrbitControls enableDamping makeDefault />
    </Canvas>
  );
}
