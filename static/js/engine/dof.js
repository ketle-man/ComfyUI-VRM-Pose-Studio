// dof.js — 被写界深度(ピント外のぼけ)
//
// シーンを深度テクスチャ付きのレンダーターゲットへ描き、全画面の 1 パスで円形にぼかして画面へ出す。
// ・ぼけの半径(CoC)はピントからの距離に比例: strength * |z - focus| / z(最大 maxBlur。画面の高さに対する割合)
//   なので出力解像度を変えても見た目は同じ
// ・ターゲットへの描画ではトーンマッピング・sRGB 変換がかからないので、合成パスでまとめてかける
// ・writeDepth: 元の深度を書き戻す(ビューポートでギズモ・グリッドを後から深度付きで重ねるため)
// ・VRM の髪先などの半透明マテリアルは深度を書かないため、そのままだと「背景」としてぼかされて周りへにじむ。
//   この描画の間だけ深度を書かせ、ほぼ透明な画素は捨てる(alphaTest)

import * as THREE from "../../vendor/three.module.js";

export const DEFAULT_DOF = { enabled: false, focus: 3, focusOn: "", strength: 0.6, maxBlur: 1.2 };

const SAMPLES = 64;

const fragmentShader = /* glsl */`
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float cameraNear;
uniform float cameraFar;
uniform float focus;
uniform float strength;
uniform float maxBlur;
uniform float aspect;
uniform float texelY;
varying vec2 vUv;

float distAt(vec2 uv) {
    return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
}
// 周囲 1 画素の中でいちばん手前の距離。アンチエイリアスで前景の色が混ざった輪郭の画素を「前景」として扱う
float nearDistAt(vec2 uv) {
    vec2 t = vec2(texelY / aspect, texelY);
    float z = distAt(uv);
    z = min(z, distAt(uv + vec2(t.x, 0.0)));
    z = min(z, distAt(uv - vec2(t.x, 0.0)));
    z = min(z, distAt(uv + vec2(0.0, t.y)));
    z = min(z, distAt(uv - vec2(0.0, t.y)));
    return z;
}
float cocAt(float z) {
    return clamp(strength * abs(z - focus) / max(z, 1e-3), 0.0, 1.0) * maxBlur;
}

void main() {
    float z0 = distAt(vUv);
    float c0 = cocAt(z0);
    vec4 sum = texture2D(tColor, vUv);
    float wsum = 1.0;
    if (c0 > 0.0005) {
        vec2 scale = vec2(c0 / aspect, c0);
        for (int i = 0; i < ${SAMPLES}; i++) {
            float fi = float(i) + 0.5;
            float r = sqrt(fi / float(${SAMPLES}));
            float a = fi * 2.39996323;
            vec2 uv = vUv + vec2(cos(a), sin(a)) * r * scale;
            float zs = nearDistAt(uv);
            // 手前のものは、それ自身のぼけがこの画素まで届くときだけ混ぜる(ピントの合った輪郭が後ろのぼけへにじまないように)。
            // 1.5 画素ぶんの余裕で輪郭のアンチエイリアスを残す
            float w = zs < z0 ? clamp((cocAt(zs) - r * c0) / (1.5 * texelY) + 1.0, 0.0, 1.0) : 1.0;
            sum += texture2D(tColor, uv) * w;
            wsum += w;
        }
    }
    gl_FragColor = sum / wsum;
    #ifdef WRITE_DEPTH
    gl_FragDepth = texture2D(tDepth, vUv).x;
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

export class DepthOfField {
    constructor() {
        this.target = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            samples: 4,
            // 色も深度と同じく最近傍で読む(線形補間だと輪郭の色が「背景」の深度のまま混ざり、ぼけの中に筋が出る)
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthTexture: new THREE.DepthTexture(1, 1),
        });
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tColor: { value: this.target.texture },
                tDepth: { value: this.target.depthTexture },
                cameraNear: { value: 0.1 }, cameraFar: { value: 100 },
                focus: { value: 3 }, strength: { value: 0.5 }, maxBlur: { value: 0.01 }, aspect: { value: 1 }, texelY: { value: 1 },
            },
            vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
            fragmentShader,
            depthTest: true,
            depthFunc: THREE.AlwaysDepth,
            depthWrite: true,
            transparent: false,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    // params: { focus(m), strength, maxBlur(画面の高さに対する %) }
    render(renderer, scene, camera, params, { writeDepth = false } = {}) {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        if (this.target.width !== size.x || this.target.height !== size.y) this.target.setSize(size.x, size.y);

        const restore = new Map(); // 同じマテリアルを複数のメッシュが使うので 1 回だけ記録する
        scene.traverseVisible(o => {
            if (!o.isMesh) return;
            for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
                if (!m?.transparent || m.depthWrite) continue;
                restore.set(m, m.alphaTest);
                m.depthWrite = true;
                m.alphaTest = Math.max(m.alphaTest, 0.05);
            }
        });
        const prevTarget = renderer.getRenderTarget();
        try {
            renderer.setRenderTarget(this.target);
            renderer.clear();
            renderer.render(scene, camera);
        } finally {
            renderer.setRenderTarget(prevTarget);
            for (const [m, a] of restore) { m.depthWrite = false; m.alphaTest = a; }
        }

        const u = this.material.uniforms;
        u.cameraNear.value = camera.near;
        u.cameraFar.value = camera.far;
        u.focus.value = Math.max(0.05, params.focus);
        u.strength.value = params.strength;
        u.maxBlur.value = params.maxBlur / 100;
        u.aspect.value = size.x / size.y;
        u.texelY.value = 1 / size.y;
        const want = writeDepth ? "" : undefined;
        if ((this.material.defines.WRITE_DEPTH) !== want) {
            if (writeDepth) this.material.defines.WRITE_DEPTH = ""; else delete this.material.defines.WRITE_DEPTH;
            this.material.needsUpdate = true;
        }
        const autoClear = renderer.autoClear;
        renderer.autoClear = true;
        renderer.render(this.quad, this.quadCam);
        renderer.autoClear = autoClear;
    }

    dispose() {
        this.target.depthTexture?.dispose();
        this.target.dispose();
        this.material.dispose();
        this.quad.geometry.dispose();
    }
}
