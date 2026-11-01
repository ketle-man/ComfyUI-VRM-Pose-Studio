// viewport.js — レンダラー・カメラ・操作(Orbit / Transform)・ピッキング・書き出し用キャプチャ
//
// キャンバスは常に「出力解像度と同じアスペクト比」でコンテナ内にレターボックス表示する。
// そのためビューポートで見えている構図がそのまま書き出される(WYSIWYG)。

import * as THREE from "../../vendor/three.module.js";
import { OrbitControls } from "../../vendor/OrbitControls.js";
import { TransformControls } from "../../vendor/TransformControls.js";
import { DepthOfField } from "./dof.js";

// 書き出し時に隠すオブジェクトのレイヤー(ハンドル・ギズモ・グリッド・ヘルパー)
export const HELPER_LAYER = 1;

export class Viewport extends EventTarget {
    constructor(container) {
        super();
        this.container = container;
        this.canvas = document.createElement("canvas");
        this.canvas.className = "vps-canvas";
        container.appendChild(this.canvas);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 500);
        this.camera.position.set(0, 1.2, 4.2);
        this.camera.layers.enable(HELPER_LAYER);

        this.orbit = new OrbitControls(this.camera, this.canvas);
        this.orbit.target.set(0, 0.95, 0);
        this.orbit.enableDamping = false;
        this.orbit.update();

        this.transform = new TransformControls(this.camera, this.canvas);
        this.transform.setSize(0.8);
        this.scene.add(this.transform);
        this.transform.addEventListener("dragging-changed", (e) => {
            this.orbit.enabled = !e.value;
            this._transformDragging = e.value;
            this.dispatchEvent(new CustomEvent(e.value ? "transform-start" : "transform-end"));
        });
        this.transform.addEventListener("objectChange", () => this.dispatchEvent(new CustomEvent("transform-change")));

        this.helpers = new THREE.Group();
        this.helpers.name = "vps-helpers";
        this.scene.add(this.helpers);
        const grid = new THREE.GridHelper(20, 40, 0x556080, 0x2c3450);
        grid.layers.set(HELPER_LAYER);
        grid.material.transparent = true;
        grid.material.opacity = 0.6;
        this.grid = grid;
        this.helpers.add(grid);

        this.aspect = 1;
        this.outputSize = { width: 1024, height: 1024 };
        // 被写界深度: () => { focus, strength, maxBlur } | null(Studio が見ているカメラの設定を返す)
        this.dofProvider = null;
        this._dof = null;
        // 小窓: () => { state, color } | null。モニター中に本番カメラの映りを右下へ重ねる(書き出しには写らない)
        this.pipProvider = null;
        this._pipCam = new THREE.PerspectiveCamera(35, 1, 0.05, 500);
        this._beforeRender = [];
        this._clock = new THREE.Clock();
        this._raycaster = new THREE.Raycaster();
        this._raycaster.layers.enableAll();
        this._capturing = false;

        this.superSample = false;
        this.zoomMode = "wheel";   // "wheel" | "ctrlDrag"
        this._setupPointer();
        this._setupDragZoom();
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(container);
        this.resize();
        this.renderer.setAnimationLoop(() => this._tick());
    }

    // ---- サイズ ----
    setOutputSize(width, height) {
        this.outputSize = { width, height };
        this.resize();
    }

    resize() {
        if (this._capturing) return;
        const cw = this.container.clientWidth, ch = this.container.clientHeight;
        if (!cw || !ch) return;
        const a = this.outputSize.width / this.outputSize.height;
        let w = cw, h = cw / a;
        if (h > ch) { h = ch; w = ch * a; }
        w = Math.floor(w); h = Math.floor(h);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = a;
        this.camera.updateProjectionMatrix();
        this.aspect = a;
        this.dispatchEvent(new CustomEvent("resize", { detail: { width: w, height: h, aspect: a } }));
    }

    // ---- ループ ----
    onBeforeRender(fn) { this._beforeRender.push(fn); }

    _tick() {
        if (this._capturing || this._paused) { this._clock.getDelta(); return; }
        const dt = Math.min(this._clock.getDelta(), 0.1);
        for (const fn of this._beforeRender) fn(dt);
        this._render();
        const pip = this.pipProvider?.();
        if (pip) this._renderPip(pip);
    }

    // 小窓はぼけ(被写界深度)なし・ヘルパーなしで描く。枠はカメラの色
    _renderPip({ state, color }) {
        const r = this.renderer, cam = this._pipCam;
        const size = r.getSize(new THREE.Vector2());
        const w = Math.round(Math.max(120, size.x * 0.28)), h = Math.round(w / this.aspect);
        if (w > size.x - 16 || h > size.y - 16) return;
        const x = size.x - w - 8, y = 8, b = 2;
        cam.position.fromArray(state.position);
        cam.lookAt(new THREE.Vector3().fromArray(state.target));
        cam.fov = state.fov;
        cam.aspect = this.aspect;
        cam.updateProjectionMatrix();
        const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
        const autoClear = r.autoClear, tVis = this.transform.visible;
        this.transform.visible = false; // ギズモはヘルパーのレイヤーに無いので個別に隠す
        try {
            r.setScissorTest(true);
            r.setScissor(x - b, y - b, w + 2 * b, h + 2 * b);
            r.setClearColor(color, 1);
            r.clear();
            r.setClearColor(0x11131c, 1);
            r.setViewport(x, y, w, h);
            r.setScissor(x, y, w, h);
            r.autoClear = true;
            r.render(this.scene, cam);
        } finally {
            r.setScissorTest(false);
            r.setViewport(0, 0, size.x, size.y);
            r.setClearColor(prevClear, prevAlpha);
            r.autoClear = autoClear;
            this.transform.visible = tVis;
        }
    }

    // 被写界深度が有効なら、ぼかした絵の上にヘルパー(ギズモ・グリッド・関節など)を深度付きで重ねる
    _render({ postFx = true } = {}) {
        const r = this.renderer, cam = this.camera;
        const dof = postFx ? this.dofProvider?.() : null;
        if (!dof) { r.render(this.scene, cam); return; }
        this._dof ??= new DepthOfField();
        const helpers = cam.layers.isEnabled(HELPER_LAYER);
        const tVis = this.transform.visible;
        cam.layers.disable(HELPER_LAYER);
        this.transform.visible = false;
        this._dof.render(r, this.scene, cam, dof, { writeDepth: helpers });
        this.transform.visible = tVis;
        if (!helpers) return;
        const bg = this.scene.background, autoClear = r.autoClear, shadowAuto = r.shadowMap.autoUpdate;
        this.scene.background = null;
        r.autoClear = false;
        r.shadowMap.autoUpdate = false;
        try {
            cam.layers.set(HELPER_LAYER);
            r.render(this.scene, cam);
            cam.layers.set(0);
            if (tVis) r.render(this.transform, cam);
        } finally {
            cam.layers.set(0);
            cam.layers.enable(HELPER_LAYER);
            this.scene.background = bg;
            r.autoClear = autoClear;
            r.shadowMap.autoUpdate = shadowAuto;
        }
    }

    // ---- ピッキング ----
    _setupPointer() {
        let down = null;
        this.canvas.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            down = { x: e.clientX, y: e.clientY };
        });
        this.canvas.addEventListener("pointerup", (e) => {
            if (e.button !== 0 || !down) return;
            const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
            down = null;
            // ドラッグ(視点回転・ギズモ操作)はクリック扱いしない
            if (moved > 4 || this._transformDragging || this.transform.axis) return;
            this.dispatchEvent(new CustomEvent("pick", { detail: { ndc: this.toNdc(e), shiftKey: e.shiftKey, event: e } }));
        });
        this.canvas.addEventListener("dblclick", (e) => {
            this.dispatchEvent(new CustomEvent("dblpick", { detail: { ndc: this.toNdc(e) } }));
        });
    }

    // Alt+左ドラッグ(常時)/ Ctrl+右ドラッグ(zoomMode = "ctrlDrag" のとき)でズームする。
    // 3D Pose Editor と同じく、OrbitControls の回転・パンを一時的に止めてドラッグを横取りする
    _setupDragZoom() {
        let drag = null;
        const end = () => {
            if (!drag) return;
            drag = null;
            this.orbit.enableRotate = true;
            this.orbit.enablePan = true;
        };
        this.canvas.addEventListener("contextmenu", e => e.preventDefault());
        this.canvas.addEventListener("pointerdown", (e) => {
            const alt = e.button === 0 && e.altKey;
            const ctrl = e.button === 2 && e.ctrlKey && this.zoomMode === "ctrlDrag";
            if ((!alt && !ctrl) || this.transform.axis) return;
            drag = { y: e.clientY };
            this.orbit.enableRotate = false;
            this.orbit.enablePan = false;
        });
        window.addEventListener("pointermove", (e) => {
            if (!drag) return;
            const dy = e.clientY - drag.y;
            drag.y = e.clientY;
            this.dolly(dy * 0.005 * this.orbit.zoomSpeed);
        });
        window.addEventListener("pointerup", end);
        window.addEventListener("keyup", (e) => { if (e.key === "Alt" || e.key === "Control") end(); });
    }

    // 注視点までの距離を (1 + amount) 倍にする(正で遠ざかる)
    dolly(amount) {
        const offset = this.camera.position.clone().sub(this.orbit.target);
        const dist = Math.max(0.05, offset.length() * (1 + amount));
        this.camera.position.copy(this.orbit.target).addScaledVector(offset.normalize(), dist);
        this.orbit.update();
    }

    // ---- 操作環境設定 ----
    setSuperSample(v) {
        this.superSample = !!v;
        const base = window.devicePixelRatio || 1;
        // 実解像度を上げて輪郭のギザギザを抑える(描画負荷は増える)
        this.renderer.setPixelRatio(this.superSample ? Math.min(base * 2, 4) : base);
        this.resize();
    }

    setZoomMode(m) {
        this.zoomMode = m === "ctrlDrag" ? "ctrlDrag" : "wheel";
        this.orbit.enableZoom = this.zoomMode === "wheel";
    }

    setMouseSpeeds({ rotate, zoom, pan } = {}) {
        if (rotate) this.orbit.rotateSpeed = rotate;
        if (zoom) this.orbit.zoomSpeed = zoom;
        if (pan) this.orbit.panSpeed = pan;
    }

    // 視点操作のボタン割り当て。"left" = 左:回転・右:移動(既定)/ "middle" = 中:回転・Shift+中:移動(Blender 風)
    setOrbitButtons(scheme) {
        const M = THREE.MOUSE;
        this.orbit.mouseButtons = scheme === "middle"
            ? { LEFT: null, MIDDLE: M.ROTATE, RIGHT: M.PAN }
            : { LEFT: M.ROTATE, MIDDLE: M.DOLLY, RIGHT: M.PAN };
    }

    toNdc(e) {
        const r = this.canvas.getBoundingClientRect();
        return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }

    raycast(ndc, objects, recursive = true) {
        this._raycaster.setFromCamera(ndc, this.camera);
        return this._raycaster.intersectObjects(objects, recursive);
    }

    // ---- カメラ ----
    getCameraState() {
        return {
            position: this.camera.position.toArray(),
            target: this.orbit.target.toArray(),
            fov: this.camera.fov,
        };
    }

    setCameraState(s) {
        if (!s) return;
        if (s.position) this.camera.position.fromArray(s.position);
        if (s.target) this.orbit.target.fromArray(s.target);
        if (s.fov) { this.camera.fov = s.fov; this.camera.updateProjectionMatrix(); }
        this.camera.lookAt(this.orbit.target);
        this.orbit.update();
    }

    resetCamera() {
        this.setCameraState({ position: [0, 1.2, 4.2], target: [0, 0.95, 0], fov: 35 });
    }

    // 対象(Object3D)全体が収まるように寄る
    frameObject(obj) {
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
        const dist = size / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.1;
        this.orbit.target.copy(center);
        this.camera.position.copy(center).addScaledVector(dir, Math.max(dist, 0.5));
        this.orbit.update();
    }

    // ---- キャプチャ ----
    // 出力解像度でレンダリングし PNG Blob を返す。opts.prepare(true/false) でシーン側の一時変更を行う
    // ---- 書き出し中の点滅を隠す ----
    // キャプチャは見えているキャンバスを出力サイズに変えて描き、戻す。サイズを変えると中身が消えるので、
    // その間は今の画面を写した画像をキャンバスの上に重ねておく(入れ子で呼べる)。
    // 書き出し中は撮れたコマでこの画像を更新するので、進み具合が見える
    freeze(on) {
        if (on) {
            if (this._freezeCount++ > 0) return;
            const src = this.canvas;
            const c = document.createElement("canvas");
            c.width = src.width; c.height = src.height;
            Object.assign(c.style, {
                position: "absolute", left: `${src.offsetLeft}px`, top: `${src.offsetTop}px`,
                width: src.style.width, height: src.style.height, pointerEvents: "none",
            });
            this._freezeEl = c;
            this._drawFreeze();
            this.container.append(c);
        } else {
            if (--this._freezeCount > 0) return;
            this._freezeCount = 0;
            this._freezeEl?.remove();
            this._freezeEl = null;
        }
    }

    // 重ねた画像を今のキャンバスの中身で描き直す(透明な部分はビューポートの地の色で埋める)
    _drawFreeze() {
        const c = this._freezeEl;
        if (!c) return;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#11131c";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(this.canvas, 0, 0, this.canvas.width, this.canvas.height, 0, 0, c.width, c.height);
    }

    // preview: 撮った絵を重ねた画像に映す(マスクの撮影では映さない)
    async capture(width, height, { transparent = false, prepare, postFx = true, preview = true } = {}) {
        // 単独の静止画では自分で重ね、書き出し中(exporter が重ねている)はそれを使う
        const ownFreeze = !this._freezeEl;
        if (ownFreeze) this.freeze(true);
        this._capturing = true;
        const r = this.renderer;
        const prevPR = r.getPixelRatio();
        const prevSize = r.getSize(new THREE.Vector2());
        const prevClear = r.getClearColor(new THREE.Color());
        const prevAlpha = r.getClearAlpha();
        this.camera.layers.disable(HELPER_LAYER);
        const prevAspect = this.camera.aspect;
        try {
            prepare?.(true);
            r.setPixelRatio(1);
            r.setSize(width, height, false);
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            r.setClearColor(0x000000, transparent ? 0 : 1);
            this._render({ postFx });
            if (preview && !ownFreeze) this._drawFreeze();
            return await new Promise((res, rej) => this.canvas.toBlob(b => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
        } finally {
            prepare?.(false);
            r.setClearColor(prevClear, prevAlpha);
            r.setPixelRatio(prevPR);
            r.setSize(prevSize.x, prevSize.y, false);
            this.camera.aspect = prevAspect;
            this.camera.updateProjectionMatrix();
            this.camera.layers.enable(HELPER_LAYER);
            this._capturing = false;
            // 元のサイズで描き直してから外す(サイズを戻すとキャンバスは空になる)
            if (ownFreeze) { this._render(); this.freeze(false); }
        }
    }

    // シーンを 1 フレームだけ進める(書き出し時の決定論的な更新用。描画はしない)
    step(dt) {
        for (const fn of this._beforeRender) fn(dt);
    }

    // 書き出し中はリアルタイムの更新(物理・再生)を止める
    pauseLoop(v) { this._paused = !!v; }
}
