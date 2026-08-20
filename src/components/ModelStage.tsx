import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { DepthResult } from "@/lib/depth";
import type { CutoutResult } from "@/lib/segment";
import { buildSolidGeometry } from "@/lib/mesh";

export type ViewMode = "solid" | "wireframe" | "points";

export type DepthControls = {
  front: number;
  back: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function Model({
  depth,
  cutout,
  texture,
  relief,
  smooth,
  thickness,
  mode,
  spin,
  depthControls,
  onReady,
}: {
  depth: DepthResult;
  cutout: CutoutResult | null;
  texture: THREE.Texture;
  relief: number;
  smooth: number;
  thickness: number;
  mode: ViewMode;
  spin: boolean;
  depthControls: DepthControls;
  onReady: (o: THREE.Object3D) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const geo = useMemo(
    () => buildSolidGeometry(depth, cutout, { relief, smooth, thickness }),
    [depth, cutout, relief, smooth, thickness],
  );

  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => {
    if (group.current) onReady(group.current);
  }, [geo, mode, onReady]);

  useEffect(() => {
    if (!geo) return;
    const orig = geo.userData.originalPosition as Float32Array;
    const isFront = geo.userData.isFront as Uint8Array;
    if (!orig || !isFront) return;

    let maxX = 0;
    let maxY = 0;
    let maxZ = 0;
    for (let i = 0; i < orig.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(orig[i] as number));
      maxY = Math.max(maxY, Math.abs(orig[i + 1] as number));
      maxZ = Math.max(maxZ, Math.abs(orig[i + 2] as number));
    }
    if (maxX === 0) maxX = 1;
    if (maxY === 0) maxY = 1;
    if (maxZ === 0) maxZ = 1;

    const pos = geo.attributes.position.array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const idx = i / 3;
      const ox = orig[i] as number;
      const oy = orig[i + 1] as number;
      const oz = orig[i + 2] as number;

      let nx = ox;
      let ny = oy;
      let nz = oz;

      if (ox > 0) nx = ox + ox * (depthControls.right - 1) * (ox / maxX);
      else if (ox < 0) nx = ox + ox * (depthControls.left - 1) * (-ox / maxX);

      if (oy > 0) ny = oy + oy * (depthControls.top - 1) * (oy / maxY);
      else if (oy < 0) ny = oy + oy * (depthControls.bottom - 1) * (-oy / maxY);

      if (isFront[idx]) nz = oz + oz * (depthControls.front - 1) * (Math.abs(oz) / maxZ);
      else nz = oz + oz * (depthControls.back - 1) * (Math.abs(oz) / maxZ);

      pos[i] = nx;
      pos[i + 1] = ny;
      pos[i + 2] = nz;
    }

    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
  }, [geo, depthControls]);

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
        <mesh geometry={geo} castShadow receiveShadow>
          <meshStandardMaterial
            map={texture}
            roughness={0.7}
            metalness={0.05}
            transparent
            alphaTest={0.5}
            side={THREE.DoubleSide}
            wireframe={mode === "wireframe"}
          />
        </mesh>
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
  mode,
  spin,
  depthControls,
  onObject,
}: {
  depth: DepthResult;
  cutout: CutoutResult | null;
  imageUrl: string;
  relief: number;
  smooth: number;
  thickness: number;
  mode: ViewMode;
  spin: boolean;
  depthControls: DepthControls;
  onObject: (o: THREE.Object3D) => void;
}) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const src = cutout?.url ?? imageUrl;

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.load(src, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      setTexture(t);
    });
  }, [src]);

  if (!texture) return null;

  return (
    <Canvas dpr={[1, 2]} shadows camera={{ fov: 42 }} gl={{ antialias: true }}>
      <color attach="background" args={["#0b0d10"]} />
      <Rig />
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 5]} intensity={1.5} castShadow />
      <directionalLight position={[-4, -1, -3]} intensity={0.6} />
      <Environment preset="city" />
      <Model
        depth={depth}
        cutout={cutout}
        texture={texture}
        relief={relief}
        smooth={smooth}
        thickness={thickness}
        mode={mode}
        spin={spin}
        depthControls={depthControls}
        onReady={onObject}
      />
      <ContactShadows position={[0, -1.8, 0]} opacity={0.3} blur={2.6} far={4} />
      <OrbitControls enableDamping makeDefault />
    </Canvas>
  );
}
