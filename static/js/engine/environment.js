// environment.js — 背景(色 / 画像 / 動画)・床・ライト・色調
//
// 画像・動画の背景は scene.background のテクスチャとして描画し、出力アスペクトに合わせて
// cover(はみ出し分をトリミング)になるよう texture.repeat/offset を調整する。

import * as THREE from "../../vendor/three.module.js";
import { HELPER_LAYER } from "./viewport.js";

export const DEFAULT_ENV = {
    background: { mode: "color", color: "#3a3f4b", url: null, name: null, offset: 0, loop: true, fit: "cover" },
    ground: { visible: true, color: "#8a8f99", shadowOnly: false, size: 20 },
    grid: true,
    ambient: { color: "#ffffff", ground: "#5a5560", intensity: 1.2 },
    key: { color: "#ffffff", intensity: 2.2, azimuth: 35, elevation: 50, shadow: true },
    rim: { color: "#a8c4ff", intensity: 0.8, azimuth: 200, elevation: 30 },
    toneMapping: false,
    exposure: 1,
    // 風: azimuth / elevation は風上(吹いてくる方向)。ライトの方位・高さと同じ向きの取り方
    wind: { enabled: false, strength: 1, azimuth: 90, elevation: 0, turbulence: 0.4 },
};

// 風上の方向(単位ベクトル)
export function windFrom(w, out = new THREE.Vector3()) {
    const az = deg(w.azimuth), el = deg(w.elevation);
    return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// 時刻 t(秒)の風ベクトル。強さのゆらぎ(ガスト)と向きのそよぎは 3D Pose Editor と同じ式。
// 書き出しではタイムラインの時刻を渡すので、何度書き出しても同じ揺れ方になる
const _up = new THREE.Vector3(0, 1, 0), _alt = new THREE.Vector3(1, 0, 0);
const _right = new THREE.Vector3(), _axis = new THREE.Vector3(), _q = new THREE.Quaternion();
export function windVector(w, t, out = new THREE.Vector3()) {
    const gust = 0.55 * Math.sin(2 * Math.PI * t / 6.7) + 0.30 * Math.sin(2 * Math.PI * t / 2.3 + 1.7) + 0.15 * Math.sin(2 * Math.PI * t / 0.9 + 4.1);
    const strength = Math.max(0, w.strength * (1 + w.turbulence * gust));
    const sway = 18 * Math.sin(2 * Math.PI * t / 5.3 + 0.6) + 7 * Math.sin(2 * Math.PI * t / 1.6 + 2.9);
    const dir = windFrom(w, out).negate();
    _right.crossVectors(Math.abs(dir.y) > 0.99 ? _alt : _up, dir).normalize();
    _axis.crossVectors(dir, _right).normalize();
    _q.setFromAxisAngle(_axis, deg(w.turbulence * sway));
    return dir.applyQuaternion(_q).multiplyScalar(strength);
}

function deg(d) { return (d * Math.PI) / 180; }

const WIND_CENTER = new THREE.Vector3(0, 1.2, 0), WIND_RADIUS = 0.9;

export class Environment {
    constructor(viewport) {
        this.vp = viewport;
        const scene = viewport.scene;
        this.state = structuredClone(DEFAULT_ENV);

        this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
        scene.add(this.hemi);

        this.key = new THREE.DirectionalLight(0xffffff, 2);
        this.key.castShadow = true;
        this.key.shadow.mapSize.set(2048, 2048);
        this.key.shadow.bias = -0.0004;
        this.key.shadow.normalBias = 0.02;
        const sc = this.key.shadow.camera;
        sc.left = -4; sc.right = 4; sc.top = 4; sc.bottom = -4; sc.near = 0.1; sc.far = 40;
        scene.add(this.key, this.key.target);

        this.rim = new THREE.DirectionalLight(0xffffff, 0.8);
        scene.add(this.rim, this.rim.target);

        this.groundMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.95 });
        this.shadowMat = new THREE.ShadowMaterial({ opacity: 0.35 });
        this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.receiveShadow = true;
        this.ground.name = "vps-ground";
        scene.add(this.ground);

        // 風向きの矢印(書き出しには写らない)
        this.windArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.9, 0x7fd8ff, 0.22, 0.12);
        this.windArrow.traverse(o => o.layers.set(HELPER_LAYER));
        this.windArrow.visible = false;
        viewport.helpers.add(this.windArrow);
        // 風上の位置に置くつまみ。選んでギズモで動かすと、そこから人物へ向かって吹く
        this.windHandle = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x7fd8ff, depthTest: false, transparent: true, opacity: 0.9 }));
        this.windHandle.renderOrder = 999;
        this.windHandle.layers.set(HELPER_LAYER);
        this.windHandle.visible = false;
        // 風のつまみと矢印を出すか(表示だけの設定。風そのものは止めない)
        this.windHelperVisible = true;
        viewport.helpers.add(this.windHandle);

        this._tex = null;
        this._video = null;
        viewport.addEventListener("resize", () => this._fitTexture());
        // 画面表示(枠の外側まで描く)と撮影(枠だけ)の切り替えで、背景の拡大率が変わる
        viewport.addEventListener("overscan", () => this._fitTexture());
        this.apply(this.state);
    }

    get video() { return this._video; }

    async apply(s) {
        const prevBg = this.state.background;
        this.state = { ...structuredClone(DEFAULT_ENV), ...structuredClone(s) };
        this._applySync();
        const bg = this.state.background;
        const sameSource = prevBg && prevBg.mode === bg.mode && prevBg.url === bg.url;
        const needsTex = bg.mode === "image" || bg.mode === "video";
        if (!sameSource || (needsTex && !this._tex)) await this._loadBackground(bg);
        if (this._video) this._video.loop = !!bg.loop;
        this._applyBackground();
    }

    // 読み込みを伴わない設定(ライト・床・色調)を反映する。タイムラインの再生中は毎フレーム呼ばれる
    _applySync() {
        const st = this.state;
        const vp = this.vp;
        this.hemi.color.set(st.ambient.color);
        this.hemi.groundColor.set(st.ambient.ground);
        this.hemi.intensity = st.ambient.intensity;
        this._placeLight(this.key, st.key);
        this.key.castShadow = !!st.key.shadow;
        this._placeLight(this.rim, st.rim);

        this.ground.visible = st.ground.visible;
        this.ground.material = st.ground.shadowOnly ? this.shadowMat : this.groundMat;
        this.groundMat.color.set(st.ground.color);
        this.ground.scale.set(st.ground.size, st.ground.size, 1);
        vp.grid.visible = st.grid;

        this._placeWind(!this.windDragging);

        const tm = st.toneMapping ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
        if (vp.renderer.toneMapping !== tm) {
            vp.renderer.toneMapping = tm;
            // トーンマッピングはシェーダーに埋め込まれるので、切り替えたときだけ作り直す
            vp.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => (m.needsUpdate = true)); });
        }
        vp.renderer.toneMappingExposure = st.exposure;
        if (st.background.mode === "color" && vp.scene.background?.isColor) vp.scene.background.set(st.background.color);
    }

    // ---- タイムライン(scene トラック)用 ----
    // 補間する値だけを取り出す。背景の画像・動画の差し替えや ON/OFF 系はキーにしない
    getAnimState() {
        const s = this.state;
        return structuredClone({
            ambient: { color: s.ambient.color, ground: s.ambient.ground, intensity: s.ambient.intensity },
            key: { color: s.key.color, intensity: s.key.intensity, azimuth: s.key.azimuth, elevation: s.key.elevation },
            rim: { color: s.rim.color, intensity: s.rim.intensity, azimuth: s.rim.azimuth, elevation: s.rim.elevation },
            exposure: s.exposure,
            background: { color: s.background.color },
            ground: { color: s.ground.color },
        });
    }

    // 風上から人物の胸のあたりへ向かう矢印と、風上のつまみ(moveHandle: つまみも矢印の根元へ戻す)
    _placeWind(moveHandle = true) {
        const w = this.state.wind;
        this.windArrow.visible = this.windHandle.visible = !!w.enabled && this.windHelperVisible;
        if (!w.enabled) return;
        const from = windFrom(w);
        this.windArrow.position.copy(WIND_CENTER).addScaledVector(from, WIND_RADIUS);
        this.windArrow.setDirection(from.negate());
        // 長さは強さ(人物を突き抜けないよう 0.7m まで)
        this.windArrow.setLength(Math.min(0.7, 0.3 + 0.1 * w.strength), 0.14, 0.08);
        if (moveHandle) this.windHandle.position.copy(this.windArrow.position);
    }

    // ギズモで動かしたつまみの位置から風上の方位・仰角を決める
    windFromHandle() {
        const d = this.windHandle.position.clone().sub(WIND_CENTER);
        if (d.lengthSq() < 1e-6) return;
        d.normalize();
        const w = this.state.wind;
        w.azimuth = Math.round(Math.atan2(d.x, d.z) * 180 / Math.PI * 10) / 10;
        w.elevation = Math.round(Math.max(-60, Math.min(60, Math.asin(d.y) * 180 / Math.PI)) * 10) / 10;
        this._placeWind(false);
    }

    // 風はタイムラインの別のトラック(WIND_TRACK)。setAnimState で戻す
    getWindState() {
        const w = this.state.wind;
        return { wind: { enabled: w.enabled, strength: w.strength, azimuth: w.azimuth, elevation: w.elevation, turbulence: w.turbulence } };
    }

    setAnimState(a) {
        if (!a) return;
        const s = this.state;
        for (const k of ["ambient", "key", "rim", "wind"]) if (a[k]) Object.assign(s[k], a[k]);
        if (a.exposure !== undefined) s.exposure = a.exposure;
        if (a.background?.color) s.background.color = a.background.color;
        if (a.ground?.color) s.ground.color = a.ground.color;
        this._applySync();
    }

    _placeLight(light, cfg) {
        light.color.set(cfg.color);
        light.intensity = cfg.intensity;
        const r = 10, az = deg(cfg.azimuth), el = deg(cfg.elevation);
        light.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r);
        light.target.position.set(0, 0.9, 0);
    }

    async _loadBackground(bg) {
        this._disposeBg();
        if (bg.mode === "image" && bg.url) {
            const tex = await new THREE.TextureLoader().loadAsync(bg.url);
            tex.colorSpace = THREE.SRGBColorSpace;
            this._tex = tex;
        } else if (bg.mode === "video" && bg.url) {
            const v = document.createElement("video");
            v.src = bg.url;
            v.muted = true;
            v.playsInline = true;
            v.crossOrigin = "anonymous";
            v.preload = "auto";
            await new Promise((res, rej) => {
                v.addEventListener("loadeddata", res, { once: true });
                v.addEventListener("error", () => rej(new Error("video load failed")), { once: true });
            });
            const tex = new THREE.VideoTexture(v);
            tex.colorSpace = THREE.SRGBColorSpace;
            this._video = v;
            this._tex = tex;
        }
    }

    _disposeBg() {
        if (this._video) { this._video.pause(); this._video.removeAttribute("src"); this._video.load(); }
        this._video = null;
        this._tex?.dispose();
        this._tex = null;
    }

    _applyBackground() {
        const bg = this.state.background;
        const scene = this.vp.scene;
        if ((bg.mode === "image" || bg.mode === "video") && this._tex) {
            scene.background = this._tex;
            this._fitTexture();
        } else if (bg.mode === "transparent") {
            scene.background = null;
        } else {
            scene.background = new THREE.Color(bg.color);
        }
    }

    _fitTexture() {
        const tex = this._tex;
        if (!tex) return;
        const img = tex.image;
        const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
        if (!iw || !ih) return;
        const ia = iw / ih, ca = this.vp.aspect;
        tex.repeat.set(1, 1);
        tex.offset.set(0, 0);
        const cover = this.state.background.fit !== "contain";
        if ((ia > ca) === cover) {
            tex.repeat.x = ca / ia;
            tex.offset.x = (1 - tex.repeat.x) / 2;
        } else {
            tex.repeat.y = ia / ca;
            tex.offset.y = (1 - tex.repeat.y) / 2;
        }
        // 背景はキャンバス全体に貼られるので、枠の外側まで描いている間は枠の中が出力と同じになるよう広げる
        const s = this.vp.bgScale ?? { x: 1, y: 1 };
        tex.offset.x += tex.repeat.x * (1 - s.x) / 2;
        tex.offset.y += tex.repeat.y * (1 - s.y) / 2;
        tex.repeat.x *= s.x;
        tex.repeat.y *= s.y;
        tex.needsUpdate = true;
    }

    // ---- 動画背景とタイムラインの同期 ----
    videoTimeAt(seconds) {
        const v = this._video;
        if (!v || !v.duration) return null;
        let t = seconds - (this.state.background.offset || 0);
        if (this.state.background.loop) t = ((t % v.duration) + v.duration) % v.duration;
        return Math.min(Math.max(t, 0), v.duration - 0.001);
    }

    syncVideo(seconds, playing) {
        const v = this._video;
        if (!v) return;
        const t = this.videoTimeAt(seconds);
        if (t === null) return;
        if (playing) {
            if (v.paused) { v.currentTime = t; v.play().catch(() => {}); }
            else if (Math.abs(v.currentTime - t) > 0.25) v.currentTime = t;
        } else {
            if (!v.paused) v.pause();
            if (Math.abs(v.currentTime - t) > 0.01) v.currentTime = t;
        }
    }

    // 書き出し用: 指定時刻へシークしてフレームが出るまで待つ
    async seekVideo(seconds) {
        const v = this._video;
        if (!v) return;
        const t = this.videoTimeAt(seconds);
        if (t === null) return;
        v.pause();
        if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
        await new Promise(res => {
            const done = () => { clearTimeout(timer); res(); };
            const timer = setTimeout(done, 3000);
            v.addEventListener("seeked", done, { once: true });
            v.currentTime = t;
        });
        if (this._tex) this._tex.needsUpdate = true;
    }

    // マスク書き出し時: 背景・床を隠す
    setMaskMode(on) {
        if (on) {
            this._saved = { bg: this.vp.scene.background, ground: this.ground.visible };
            this.vp.scene.background = null;
            this.ground.visible = false;
        } else if (this._saved) {
            this.vp.scene.background = this._saved.bg;
            this.ground.visible = this._saved.ground;
            this._saved = null;
        }
    }

    // 透過背景モードのときは書き出しも透過にする
    get transparentBackground() { return this.state.background.mode === "transparent"; }
}

export { HELPER_LAYER };
