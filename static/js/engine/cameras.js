// cameras.js — 複数カメラとカット(切り替え)
//
// ・カメラはそれぞれ state(position / target / fov)を持ち、トラック id = カメラ id でキーフレームを打てる
// ・ビューポートの描画カメラ(viewport.camera)は 1 台だけで、「いま見ているカメラ(viewId)」の state を写して使う。
//   視点操作(Orbit)の結果は viewId のカメラへ書き戻す
// ・カットトラック(CUT_TRACK)のキー { camera: id } が「その時刻から使うカメラ」。再生・書き出しはこれに従う
// ・既定のカメラの id は "camera"(旧プロジェクトの camera トラックをそのまま引き継ぐ)
// ・モニター(viewId = MONITOR)は、キーもカットも持たない第三者の自由視点。書き出しには使わない。
//   一覧(list / has)には含めず、get(MONITOR) でだけ取り出せる

import * as THREE from "../../vendor/three.module.js";
import { HELPER_LAYER } from "./viewport.js";
import { CAMERA_TRACK } from "./timeline.js";
import { newId } from "./objects.js";
import { DEFAULT_DOF } from "./dof.js";

// カメラの state に被写界深度の既定値を補う(古いプロジェクト・キーにも使う)
export function withDof(state) {
    if (!state) return state;
    return { ...state, dof: { ...DEFAULT_DOF, ...(state.dof ?? {}) } };
}

export const CUT_TRACK = "cuts";
export const MONITOR = "__monitor";
export const CAMERA_COLORS = ["#2ed573", "#ff7f50", "#4a9eff", "#e056fd", "#ffd24a", "#7bed9f", "#ff6b81", "#70a1ff"];

export class CameraRig {
    constructor(vp) {
        this.vp = vp;
        this.cams = new Map();   // id → { id, name, color, state, proxy, helper }
        this.viewId = null;
        this.helpersVisible = true;
        this.monitor = { id: MONITOR, name: "Monitor", state: null };
        this.add({ id: CAMERA_TRACK, name: "Camera 1", state: vp.getCameraState() });
        this.viewId = CAMERA_TRACK;
    }

    has(id) { return this.cams.has(id); }
    get(id) { return id === MONITOR ? this.monitor : this.cams.get(id); }
    list() { return [...this.cams.values()]; }

    add({ id, name, state, color } = {}) {
        id ??= newId("cam");
        const n = this.cams.size;
        color ??= CAMERA_COLORS[n % CAMERA_COLORS.length];
        // 他のカメラの位置・向きを示すヘルパー(書き出しには写らない)
        const proxy = new THREE.PerspectiveCamera(35, 1, 0.05, 0.6);
        const helper = new THREE.CameraHelper(proxy);
        helper.layers.set(HELPER_LAYER);
        helper.setColors(new THREE.Color(color), new THREE.Color(color), new THREE.Color(color), new THREE.Color(color), new THREE.Color(color));
        this.vp.helpers.add(helper);
        // モニター中にギズモで動かすため proxy もシーンに置く。クリックで選べるよう見えない当たり判定の箱を付ける
        proxy.layers.set(HELPER_LAYER);
        const pick = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.34), new THREE.MeshBasicMaterial({ visible: false }));
        pick.position.z = 0.1;
        pick.layers.set(HELPER_LAYER);
        pick.userData.camId = id;
        proxy.add(pick);
        this.vp.helpers.add(proxy);
        const cam = { id, name: name ?? `Camera ${n + 1}`, color, state: withDof(structuredClone(state ?? this.vp.getCameraState())), proxy, helper, pick };
        this.cams.set(id, cam);
        return cam;
    }

    remove(id) {
        const c = this.cams.get(id);
        if (!c || this.cams.size <= 1) return false;
        this._dispose(c);
        this.cams.delete(id);
        if (this.viewId === id) this.setView(this.list()[0].id);
        return true;
    }

    _dispose(c) {
        c.helper.removeFromParent();
        c.helper.dispose();
        c.proxy.removeFromParent();
        c.pick.geometry.dispose();
        c.pick.material.dispose();
    }

    // ビューポートが見るカメラを切り替える(切り替える前に、今のカメラへ視点を書き戻す)
    setView(id) {
        const c = id === MONITOR ? this.monitor : (this.cams.get(id) ?? this.list()[0]);
        if (this.viewId !== c.id) this.syncFromViewport();
        // 初めてモニターにするときは、今見ている視点から始める(画面が飛ばないように)
        if (c === this.monitor && !c.state) c.state = withDof(this.vp.getCameraState());
        this.viewId = c.id;
        this.vp.setCameraState(c.state);
    }

    syncFromViewport() {
        const c = this.get(this.viewId);
        // 視点(位置・注視点・画角)だけ書き戻し、被写界深度などの設定は残す
        if (c) c.state = { ...c.state, ...this.vp.getCameraState() };
    }

    setState(id, state) {
        const c = this.cams.get(id);
        if (!c || !state) return;
        c.state = withDof({ ...c.state, ...structuredClone(state) });
        if (id === this.viewId) this.vp.setCameraState(c.state);
    }

    // その時刻に使うカメラ。最初のカットより前は最初のカットのカメラ、カットが無ければ既定のカメラ
    cutAt(timeline, frame) {
        const keys = timeline.keys(CUT_TRACK).filter(k => this.cams.has(k.state?.camera));
        if (!keys.length) return this.cams.has(CAMERA_TRACK) ? CAMERA_TRACK : this.list()[0].id;
        let pick = keys[0];
        for (const k of keys) { if (k.frame <= frame + 1e-6) pick = k; else break; }
        return pick.state.camera;
    }

    updateHelpers() {
        const aspect = this.vp.aspect;
        for (const c of this.cams.values()) {
            const show = this.helpersVisible && c.id !== this.viewId;
            c.helper.visible = show;
            if (!show) continue;
            const s = c.state;
            c.proxy.position.fromArray(s.position);
            c.proxy.lookAt(new THREE.Vector3().fromArray(s.target));
            c.proxy.fov = s.fov;
            c.proxy.aspect = aspect;
            c.proxy.updateProjectionMatrix();
            c.proxy.updateMatrixWorld(true);
            c.helper.update();
        }
    }

    serialize() {
        this.syncFromViewport();
        return this.list().map(c => ({ id: c.id, name: c.name, color: c.color, state: structuredClone(c.state) }));
    }

    // keepStates: 既存のカメラの視点は残す(undo で視点が戻らないように)
    load(list, { keepStates = false } = {}) {
        this.syncFromViewport();
        const wanted = new Map(list.map(c => [c.id, c]));
        for (const id of [...this.cams.keys()]) {
            if (!wanted.has(id)) {
                this._dispose(this.cams.get(id));
                this.cams.delete(id);
            }
        }
        for (const d of list) {
            const c = this.cams.get(d.id);
            if (!c) this.add(d);
            else {
                c.name = d.name ?? c.name;
                if (d.color) { c.color = d.color; const col = new THREE.Color(d.color); c.helper.setColors(col, col, col, col, col); }
                if (!keepStates && d.state) c.state = withDof(structuredClone(d.state));
            }
        }
        if (!this.cams.size) this.add({ id: CAMERA_TRACK, name: "Camera 1" });
        if (this.viewId !== MONITOR && !this.cams.has(this.viewId)) this.viewId = this.list()[0].id;
        this.vp.setCameraState(this.get(this.viewId).state);
    }
}
