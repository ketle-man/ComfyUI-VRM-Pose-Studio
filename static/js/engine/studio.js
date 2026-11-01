// studio.js — シーン全体の統括(オブジェクト管理・選択・タイムライン適用・再生・履歴・保存形式)
//
// UI はこのクラスのメソッドを呼び、発火するイベントを購読して表示を更新する。
//   objects   オブジェクトの追加・削除・並び・名前・親子が変わった
//   selection 選択(オブジェクト / ボーン / カメラ / scene)が変わった
//   cameras   カメラの追加・削除・名前・カットが変わった
//   edited    選択中オブジェクトの状態が変わった(インスペクタの値を更新する)
//   frame     現在フレームが変わった
//   env       背景・ライトが変わった
//   output    出力解像度が変わった
//   playing   再生状態が変わった
//   history   undo/redo の可否が変わった
//   regional  リージョン設定(studio.regional)がプロジェクトの読込で入れ替わった

import * as THREE from "../../vendor/three.module.js";
import { Viewport } from "./viewport.js";
import { Environment, DEFAULT_ENV, windVector } from "./environment.js";
import { Timeline, CAMERA_TRACK, SCENE_TRACK, WIND_TRACK, CHANNELS, channelTrack, parseTrack, stretchFrame } from "./timeline.js";
import { createObject, newId, MOUTH_VISEMES, EYE_BONES } from "./objects.js";
import { CameraRig, CUT_TRACK, MONITOR, withDof } from "./cameras.js";
import { analyzeAudioFile, buildVisemeTimeline, estimateSpeechDuration } from "../lib/lip_sync.js";
import { analyzeVowels } from "./vowels.js";
import { bvhTextToVrmaBuffer } from "../lib/bvh_retarget.js";

const LIP_FADE = 0.04;      // 口形の切り替わりの前後でかける短いフェード(秒)
const LIP_TEXT_LEVEL = 0.5; // 音声が無いときのセリフだけの口の開き

export const PROJECT_VERSION = 1;

// 音声クリップの長さ(秒)。trim = 元のファイルのどこから鳴らすか、length = 何秒鳴らすか(null = 最後まで)
export function clipLength(c) {
    return Math.max(0, c.length ?? ((c.duration || 0) - (c.trim || 0)));
}

export const MIN_CLIP = 0.05; // 分割でできるクリップの最短(秒)
const HISTORY_LIMIT = 60;

export class Studio extends EventTarget {
    constructor(container) {
        super();
        this.vp = new Viewport(container);
        this.env = new Environment(this.vp);
        this.timeline = new Timeline();
        this.objects = new Map();     // id → SceneObject(挿入順 = 表示順)
        this.selection = null;        // { id, bone? } / { id: カメラ id } / { id: "scene" }
        this.output = { width: 1024, height: 1024 };
        this.audios = [];             // 音声トラック [{ id, name, url, source, path, offset, duration, volume, muted }]
        this.regional = null;         // リージョンタブの設定(ui/regional.js が中身を持つ。プロジェクトに保存、undo の対象外)
        this.projectName = "untitled";
        this.autoKey = false;
        this.playing = false;
        this.loop = true;
        this.mode = "rotate";         // ボーン以外の既定は translate(selectで切替)
        this.objectMode = "translate";
        this.showAllJoints = false;
        this.showFingers = true;
        // 関節ハンドルの濃さ(表情を調整するときに薄く・透明にする)。このブラウザに覚えておく
        this.jointOpacity = 1;
        try { const v = parseFloat(localStorage.getItem("vps:jointOpacity")); if (v >= 0 && v <= 1) this.jointOpacity = v; } catch { /* ignore */ }
        this._history = [];
        this._future = [];
        this._clips = new Map();      // 音声トラック id → { el: <audio>, env, vowels, ready, timer }(保存しない実行時の情報)

        this.vp.onBeforeRender(dt => this._update(dt));
        this.vp.addEventListener("pick", e => this._onPick(e.detail));
        this.vp.addEventListener("dblpick", e => this._onDblPick(e.detail));
        this.vp.addEventListener("transform-change", () => {
            this._syncCameraFromGizmo();
            if (this.vp.transform.object === this.env.windHandle) { this.env.windDragging = true; this.env.windFromHandle(); }
            this._emit("edited");
        });
        this.vp.addEventListener("transform-end", () => {
            if (this.env.windDragging) {
                // つまみを矢印の根元(決まった距離)へ戻す
                this.env.windDragging = false;
                this.env._placeWind(true);
                this._emit("env");
            }
            this._afterEdit();
        });
        this.cams = new CameraRig(this.vp);
        try { this.env.windHelperVisible = localStorage.getItem("vps:windHelper") !== "0"; } catch { /* ignore */ }
        this.vp.dofProvider = () => this._dofParams();
        this.monitor = false;
        this.vp.pipProvider = () => {
            if (!this.monitor) return null;
            const c = this.cams.get(this._shotCamera());
            return c ? { state: c.state, color: c.color } : null;
        };
        // 視点操作の結果は「いま見ているカメラ」へ書き戻す
        this.vp.orbit.addEventListener("change", () => this.cams.syncFromViewport());
        this.vp.orbit.addEventListener("end", () => {
            // モニター中の視点操作はカメラを動かさないので、キーも打たない
            if (this.autoKey && this.cams.has(this.selection?.id) && this.selection.id === this.cams.viewId) this.keySelected();
            this._emit("edited");
        });
        this.timeline.addEventListener("change", () => this._emit("timeline"));
        this.setOutputSize(1024, 1024);
        this._pushHistory();
    }

    _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    // ================================================================ objects

    list() { return [...this.objects.values()]; }
    get(id) { return this.objects.get(id); }
    actors() { return this.list().filter(o => o.type === "actor"); }

    async addObject(data, { select = true, record = true } = {}) {
        const obj = await createObject({ ...data, id: data.id || undefined });
        this.objects.set(obj.id, obj);
        obj.setHandleOpacity?.(this.jointOpacity);
        this.vp.scene.add(obj.root);
        if (obj.type === "actor") {
            this.vp.helpers.add(obj.handles);
            obj.setFingerHandlesVisible(this.showFingers);
        }
        if (data.parent) this._attach(obj, data.parent, false);
        this._emit("objects");
        if (select) this.select(obj.id);
        if (record) this._afterEdit({ key: false });
        return obj;
    }

    removeObject(id) {
        const obj = this.objects.get(id);
        if (!obj) return;
        // この人物にアタッチされているプロップは、見た目の位置を保ったまま外す
        for (const o of this.list()) if (o.parentRef?.actorId === id) this.detach(o.id, false);
        if (this.selection?.id === id) this.select(null);
        obj.dispose();
        this.objects.delete(id);
        this.timeline.removeTrack(id);
        for (const ch of CHANNELS) this.timeline.removeTrack(channelTrack(id, ch));
        // この人物を見ていた視線は外す
        for (const a of this.actors()) if (a.lookAtTarget === id) a.lookAtTarget = "";
        this._emit("objects");
        this._afterEdit({ key: false });
    }

    async duplicate(id) {
        const obj = this.objects.get(id);
        if (!obj) return;
        const data = obj.serialize();
        data.id = newId(obj.type);
        data.name = `${obj.name} copy`;
        data.parent = null;
        const copy = await this.addObject(data, { record: false });
        if (!obj.parentRef) copy.root.position.x += 0.6;
        else { copy.root.matrix.copy(obj.root.matrixWorld); copy.root.matrix.decompose(copy.root.position, copy.root.quaternion, copy.root.scale); }
        for (const [from, to] of [[id, copy.id], ...CHANNELS.map(ch => [channelTrack(id, ch), channelTrack(copy.id, ch)])]) {
            const keys = this.timeline.keys(from);
            if (keys.length) this.timeline.tracks[to] = structuredClone(keys);
        }
        this._afterEdit({ key: false });
        return copy;
    }

    rename(id, name) {
        const obj = this.objects.get(id);
        if (!obj || !name) return;
        obj.name = name;
        obj.root.name = name;
        this._emit("objects");
        this._afterEdit({ key: false });
    }

    moveInOrder(id, dir) {
        const ids = [...this.objects.keys()];
        const i = ids.indexOf(id), j = i + dir;
        if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        const m = new Map(ids.map(k => [k, this.objects.get(k)]));
        this.objects = m;
        this._emit("objects");
    }

    setVisible(id, v) {
        const obj = this.objects.get(id);
        if (!obj) return;
        obj.visible = v;
        this._emit("objects");
        this._afterEdit();
    }

    setLocked(id, v) {
        const obj = this.objects.get(id);
        if (!obj) return;
        obj.locked = v;
        if (v && this.selection?.id === id) this._attachGizmo();
        this._emit("objects");
    }

    // ---- アタッチ(プロップ → 人物のボーン) ----
    _attach(prop, ref, keepWorld) {
        const actor = this.objects.get(ref.actorId);
        const bone = actor?.bone?.(ref.bone);
        if (!bone) return false;
        actor.vrm.scene.updateMatrixWorld(true);
        if (keepWorld) bone.raw.attach(prop.root);
        else bone.raw.add(prop.root);
        prop.parentRef = { actorId: ref.actorId, bone: ref.bone };
        return true;
    }

    attach(propId, actorId, boneName) {
        const prop = this.objects.get(propId);
        if (!prop || prop.type === "actor") return;
        if (prop.parentRef) this.detach(propId, false);
        if (this._attach(prop, { actorId, bone: boneName }, true)) {
            // アタッチ前後でローカル座標系が変わるので、既存のキーは使えない
            this.timeline.removeTrack(propId);
            this._emit("objects");
            this._afterEdit();
        }
    }

    detach(propId, record = true) {
        const prop = this.objects.get(propId);
        if (!prop?.parentRef) return;
        this.vp.scene.attach(prop.root);
        prop.parentRef = null;
        this.timeline.removeTrack(propId);
        this._emit("objects");
        if (record) this._afterEdit();
    }

    // ================================================================ selection / gizmo

    select(id, bone = null) {
        if (id && !this.cams.has(id) && id !== SCENE_TRACK && id !== WIND_TRACK && !this.objects.has(id)) id = null;
        this.selection = id ? { id, bone } : null;
        const selActor = this.objects.get(id);
        for (const a of this.actors()) {
            a.handles.visible = this.showAllJoints || a === selActor;
            a.highlightBone(a === selActor ? bone : null);
        }
        if (bone) this.mode = bone === "hips" && this.mode === "translate" ? "translate" : "rotate";
        this._attachGizmo();
        this._updateView();
        this._emit("selection");
    }

    // ================================================================ cameras

    isCamera(id) { return this.cams.has(id); }

    // 停止中にカメラを選んでいればそのカメラ、それ以外(再生中・書き出し中を含む)はカットのカメラ
    _shotCamera() {
        const sel = this.selection?.id;
        return !this.playing && this.cams.has(sel) ? sel : this.cams.cutAt(this.timeline, this.timeline.current);
    }

    // ビューポートはモニター中ならモニター、それ以外は _shotCamera() から見る。書き出し(render)は必ずカットのカメラ
    _updateView(render = false) {
        const id = render ? this.cams.cutAt(this.timeline, this.timeline.current) : this.monitor ? MONITOR : this._shotCamera();
        if (id !== this.cams.viewId || render) this.cams.setView(id);
    }

    // ---- モニター(第三者の自由視点) ----
    // キーフレームもカットも持たず、再生中も自由に見回せる。全カメラの枠が表示され、選んだカメラをギズモで動かせる
    setMonitor(on = !this.monitor) {
        on = !!on;
        if (on === this.monitor) return;
        this.monitor = on;
        this._updateView();
        this._attachGizmo();
        this._emit("monitor");
        this._emit("selection");
    }

    // モニターの視点をカメラへ写す
    cameraFromMonitor(id) {
        const m = this.cams.get(MONITOR);
        if (!this.cams.has(id) || !m?.state) return;
        if (this.cams.viewId === MONITOR) this.cams.syncFromViewport();
        const { position, target, fov } = m.state;
        this.cams.setState(id, { position, target, fov });
        if (this.autoKey) this.keyTrack(id);
        this._emit("edited");
        this._scheduleHistory();
    }

    // ギズモでカメラの枠を動かしたら、位置と向き(注視点までの距離は保つ)を state へ書き戻す
    _syncCameraFromGizmo() {
        const c = this.monitor ? this.cams.get(this.selection?.id) : null;
        if (!c || c.id === MONITOR || this.vp.transform.object !== c.proxy) return;
        const s = c.state;
        const pos = c.proxy.position;
        const dist = Math.max(0.1, pos.distanceTo(new THREE.Vector3().fromArray(s.target)));
        const dir = c.proxy.getWorldDirection(new THREE.Vector3());
        c.state = { ...s, position: pos.toArray(), target: pos.clone().addScaledVector(dir, dist).toArray() };
    }

    addCamera({ fromView = true, select = true } = {}) {
        const c = this.cams.add({ state: fromView ? this.vp.getCameraState() : undefined });
        this._emit("cameras");
        if (select) this.select(c.id);
        this._scheduleHistory();
        return c;
    }

    removeCamera(id) {
        if (!this.cams.remove(id)) return false;
        this.timeline.removeTrack(id);
        // このカメラへのカットも消す
        for (const k of [...this.timeline.keys(CUT_TRACK)]) if (k.state?.camera === id) this.timeline.removeKey(CUT_TRACK, k.frame);
        if (this.selection?.id === id) this.select(null);
        this._emit("cameras");
        this._updateView();
        this._scheduleHistory();
        return true;
    }

    renameCamera(id, name) {
        const c = this.cams.get(id);
        if (!c || !name) return;
        c.name = name;
        this._emit("cameras");
        this._scheduleHistory();
    }

    setCameraFov(id, fov) {
        const c = this.cams.get(id);
        if (!c) return;
        this.cams.setState(id, { fov });
    }

    // その時刻からこのカメラに切り替える(カットはステップ補間)
    setCut(camId, frame = Math.round(this.timeline.current)) {
        if (!this.cams.has(camId)) return;
        this.timeline.setKey(CUT_TRACK, frame, { camera: camId }, "step");
        this._emit("cameras");
        this._updateView();
        this._scheduleHistory();
    }

    cutCameraAt(frame = this.timeline.current) { return this.cams.cutAt(this.timeline, frame); }

    // 被写界深度の設定を変える(patch: { enabled, focus, focusOn, strength, maxBlur } の一部)
    setCameraDof(id, patch) {
        const c = this.cams.get(id);
        if (!c) return;
        c.state = withDof(c.state);
        Object.assign(c.state.dof, patch);
    }

    // 今ビューポートが見ているカメラの被写界深度(無効なら null)。ピント対象があれば毎フレーム距離を測り直す
    _dofParams() {
        const d = this.cams.get(this.cams.viewId)?.state?.dof;
        if (!d?.enabled) return null;
        let focus = d.focus;
        const o = d.focusOn ? this.objects.get(d.focusOn) : null;
        if (o) {
            const p = this._focusPoint(o);
            const cam = this.vp.camera;
            focus = Math.max(0.05, p.sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3())));
        }
        return { focus, strength: d.strength, maxBlur: d.maxBlur };
    }

    // ピントを合わせる点: 人物は頭、それ以外は見た目の中心
    _focusPoint(o) {
        const head = o.bone?.("head");
        if (head) return (head.raw ?? head.node).getWorldPosition(new THREE.Vector3());
        const box = new THREE.Box3().setFromObject(o.root);
        return box.isEmpty() ? o.root.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
    }

    // 今の _dofParams() のピント距離(UI 表示用)
    currentFocusDistance(id) {
        const c = this.cams.get(id);
        if (!c) return null;
        if (id !== this.cams.viewId) return c.state.dof?.focus ?? null;
        return this._dofParams()?.focus ?? c.state.dof?.focus ?? null;
    }

    selectedObject() { return this.objects.get(this.selection?.id); }

    setTransformMode(mode) {
        if (this.selection?.bone) {
            // ボーンは回転のみ(腰だけ移動も可)
            if (mode === "scale" || (mode === "translate" && this.selection.bone !== "hips")) return;
            this.mode = mode;
        } else {
            this.objectMode = mode;
        }
        this._attachGizmo();
        this._emit("selection");
    }

    get transformMode() { return this.selection?.bone ? this.mode : this.objectMode; }

    toggleSpace() {
        const t = this.vp.transform;
        t.setSpace(t.space === "local" ? "world" : "local");
        this._emit("selection");
    }

    _attachGizmo() {
        const t = this.vp.transform;
        const cam = this.monitor ? this.cams.get(this.selection?.id) : null;
        if (cam && cam.id !== MONITOR) {
            this.cams.updateHelpers();
            t.setMode(this.objectMode === "rotate" ? "rotate" : "translate");
            t.attach(cam.proxy);
            return;
        }
        if (this.selection?.id === WIND_TRACK) {
            if (!this.env.windHandle.visible) { t.detach(); return; }
            t.setMode("translate");
            t.setSpace("world");
            t.attach(this.env.windHandle);
            return;
        }
        const obj = this.selectedObject();
        if (!obj || obj.locked) { t.detach(); return; }
        if (this.selection.bone) {
            const b = obj.bone(this.selection.bone);
            if (!b) { t.detach(); return; }
            t.setMode(this.mode);
            t.setSpace("local");
            t.attach(b.node);
        } else {
            t.setMode(this.objectMode);
            t.attach(obj.root);
        }
    }

    setShowAllJoints(v) { this.showAllJoints = v; this.select(this.selection?.id, this.selection?.bone); }
    setJointOpacity(v) {
        this.jointOpacity = Math.max(0, Math.min(1, v));
        for (const a of this.actors()) a.setHandleOpacity(this.jointOpacity);
        try { localStorage.setItem("vps:jointOpacity", String(this.jointOpacity)); } catch { /* ignore */ }
    }

    setShowFingers(v) { this.showFingers = v; for (const a of this.actors()) a.setFingerHandlesVisible(v); }

    _ownerOf(o) {
        while (o) { if (o.userData.vpsObject) return o.userData.vpsObject; o = o.parent; }
        return null;
    }

    _onPick({ ndc }) {
        // 1) 表示中の関節ハンドル
        const handles = this.actors().filter(a => a.handles.visible && a.visible).flatMap(a => a.handles.children.filter(h => h.visible && h.material.visible));
        const hh = this.vp.raycast(ndc, handles, false);
        if (hh.length) {
            const { actor, bone } = hh[0].object.userData;
            this.select(actor.id, bone.name);
            return;
        }
        // 2) オブジェクト本体
        const targets = this.list().filter(o => o.visible).flatMap(o => o.pickTargets());
        const hit = this.vp.raycast(ndc, targets, true).find(h => h.object.visible && !h.object.isLine);
        // 風上のつまみ(手前にある方)
        if (this.env.windHandle.visible) {
            const wh = this.vp.raycast(ndc, [this.env.windHandle, this.env.windArrow], true)[0];
            if (wh && (!hit || wh.distance < hit.distance)) { this.select(WIND_TRACK); return; }
        }
        // 3) モニター中はカメラの枠も選べる(手前にある方)
        if (this.monitor) {
            const ch = this.vp.raycast(ndc, this.cams.list().map(c => c.pick), false)[0];
            if (ch && (!hit || ch.distance < hit.distance)) { this.select(ch.object.userData.camId); return; }
        }
        const owner = hit ? this._ownerOf(hit.object) : null;
        this.select(owner?.id ?? null);
    }

    _onDblPick() {
        const obj = this.selectedObject();
        if (obj) this.vp.frameObject(obj.root);
    }

    // ================================================================ edit helpers

    resetPose(id) { const a = this.objects.get(id); if (a?.resetPose) { a.resetPose(); a.resetPhysics(); this._afterEdit(); this._emit("edited"); } }
    mirrorPose(id) { const a = this.objects.get(id); if (a?.mirrorPose) { a.mirrorPose(); this._afterEdit(); this._emit("edited"); } }
    resetBone(id, bone) {
        const b = this.objects.get(id)?.bone?.(bone);
        if (!b) return;
        b.node.quaternion.identity();
        this._afterEdit();
        this._emit("edited");
    }

    applyPoseJson(id, parsed) {
        const a = this.objects.get(id);
        if (!a?.importPoseJson?.(parsed)) return false;
        a.resetPhysics();
        this._afterEdit();
        this._emit("edited");
        return true;
    }

    // 外部(インスペクタ)から状態を変えたあとに呼ぶ
    // key: false … キーの移動・削除などタイムラインだけの編集(自動キーで打ち直さない)
    commitEdit({ key = true } = {}) { this._afterEdit({ key }); this._emit("edited"); }

    _afterEdit({ key = true } = {}) {
        if (key && this.autoKey && this.selection) this.keySelected();
        this._scheduleHistory();
    }

    // ================================================================ keyframes

    keySelected() {
        const id = this.selection?.id;
        if (!id) return;
        this.keyTrack(id);
        // 目のボーンを動かしたときは、目のトラックにキーがあればそちらにも打つ(無いと目のトラックに上書きされる)
        const eyes = channelTrack(id, "eyes");
        if (EYE_BONES.includes(this.selection.bone) && this.timeline.hasKeys(eyes)) this.keyTrack(eyes);
    }

    // 人物の子トラック(視線・まばたき・口パク)を変えたあとに呼ぶ。自動キーなら、その子トラックにキーを打つ
    editChannel(id, ch) {
        if (this.autoKey) this.keyTrack(channelTrack(id, ch));
        this._scheduleHistory();
        this._emit("edited");
    }

    keyTrack(id, frame = Math.round(this.timeline.current)) {
        const { owner, ch } = parseTrack(id);
        if (ch) {
            const st = this.objects.get(owner)?.getChannel?.(ch);
            if (st) this.timeline.setKey(id, frame, st);
        } else if (id === WIND_TRACK) this.timeline.setKey(id, frame, this.env.getWindState());
        else if (this.cams.has(id)) {
            if (id === this.cams.viewId) this.cams.syncFromViewport();
            this.timeline.setKey(id, frame, this.cams.get(id).state);
        } else if (id === SCENE_TRACK) this.timeline.setKey(id, frame, this.env.getAnimState());
        else {
            const obj = this.objects.get(id);
            if (!obj) return;
            this.timeline.setKey(id, frame, obj.getState());
        }
        this._scheduleHistory();
    }

    keyAll() {
        for (const o of this.list()) this.keyTrack(o.id);
    }

    // VRMA を読み込み、指定フレームからキーフレームとして並べる(every フレームおき)
    async importVrma(actorId, url, { startFrame = Math.round(this.timeline.current), every = 2 } = {}) {
        const actor = this.objects.get(actorId);
        if (!actor?.sampleVrma) return;
        return this._placeSamples(actor, await actor.sampleVrma(url, this.timeline.fps / every), startFrame);
    }

    // 読み込んだ FBX のテイクを同じように並べる。opts.rootMotion: 腰の水平移動を使うか
    async importFbx(actorId, asset, take, { startFrame = Math.round(this.timeline.current), every = 2, rootMotion = true } = {}) {
        const actor = this.objects.get(actorId);
        if (!actor?.sampleFbx) return;
        return this._placeSamples(actor, actor.sampleFbx(asset, take, this.timeline.fps / every, { rootMotion }), startFrame);
    }

    _placeSamples(actor, { samples, duration }, startFrame) {
        const actorId = actor.id;
        const fps = this.timeline.fps;
        const base = actor.getState();
        for (const s of samples) {
            this.timeline.setKey(actorId, startFrame + Math.round(s.time * fps), { ...base, pose: s.pose });
        }
        const end = startFrame + Math.ceil(duration * fps);
        if (end > this.timeline.frames) this.setTimelineLength(end);
        this.seek(this.timeline.current);
        this._scheduleHistory();
        return samples.length;
    }

    // タイムストレッチ。trackIds: 伸縮するトラック。moveAudio: 音声クリップの開始位置も合わせる
    // (音声そのものの速さは変えない。3D Pose Editor の Lip 音声と同じ)。戻り値: 間引いたキーの数
    stretchTime(range, trackIds, { moveAudio = true } = {}) {
        if (this.playing) this.play(false);
        const tl = this.timeline;
        const dropped = tl.stretch(trackIds, range);
        if (moveAudio) {
            for (const c of this.audios) c.offset = Math.max(0, +(stretchFrame(c.offset * tl.fps, range) / tl.fps).toFixed(3));
            this._emit("audios");
        }
        this.seek(Math.round(stretchFrame(tl.current, range)));
        // オートキーで余計なキーを打たないよう、キーは打たずに履歴だけ残す
        this._afterEdit({ key: false });
        this._emit("timeline");
        return dropped;
    }

    setTimelineLength(frames) {
        this.timeline.frames = Math.max(1, Math.round(frames));
        if (this.timeline.current > this.timeline.frames) this.seek(this.timeline.frames);
        this.timeline._changed();
        this._scheduleHistory();
    }

    setFps(fps) {
        // 秒数を保ったままフレーム番号を換算する
        const r = fps / this.timeline.fps;
        if (!isFinite(r) || r === 1) return;
        for (const list of Object.values(this.timeline.tracks)) for (const k of list) k.frame = Math.round(k.frame * r);
        this.timeline.frames = Math.round(this.timeline.frames * r);
        if (this.timeline.range) this.timeline.range = this.timeline.range.map(f => Math.round(f * r));
        this.timeline.fps = fps;
        this.timeline.current = Math.round(this.timeline.current * r);
        this.timeline._changed();
        this._scheduleHistory();
    }

    // BVH(SAM3DBody / CMU / Daz)をリターゲットしてキーフレームとして並べる。opts は askBvhImportOptions の戻り値
    async importBvh(actorId, text, opts = {}, { startFrame = Math.round(this.timeline.current), every = 1 } = {}) {
        const actor = this.objects.get(actorId);
        if (!actor?.vrm) return 0;
        // 3D Pose Editor の bvhTextToVrmaBuffer は editor.exportVrma(keyframes) を返すので、
        // それを受け取るだけのアダプタを渡してキーフレーム列を取り出す
        const adapter = {
            exportPose: () => JSON.stringify(actor.exportPoseJson()),
            getVRM: () => actor.vrm,
            exportVrma: kfs => kfs,
        };
        const kfs = await bvhTextToVrmaBuffer(adapter, text, opts);
        const fps = this.timeline.fps;
        const base = actor.getState();
        let n = 0, lastFrame = -1, end = startFrame;
        for (const k of kfs) {
            const frame = startFrame + Math.round(k.time * fps);
            end = Math.max(end, frame);
            if (frame === lastFrame || (frame - startFrame) % every) continue;
            lastFrame = frame;
            const pose = { bones: {}, hips: [0, 0, 0] };
            for (const [name, b] of Object.entries(k.bones)) {
                pose.bones[name] = [b.qx, b.qy, b.qz, b.qw];
                if (name === "hips" && b.px !== undefined) pose.hips = [b.px, b.py, b.pz];
            }
            this.timeline.setKey(actorId, frame, { ...base, pose });
            n++;
        }
        if (end > this.timeline.frames) this.setTimelineLength(end);
        this.seek(this.timeline.current);
        this._scheduleHistory();
        return n;
    }

    // ---- リップシンク ----
    // 時刻だけで口形が決まる(前フレームの状態を持たない)ので、シーク・書き出しでも同じ結果になる
    setLip(actorId, patch) {
        const a = this.objects.get(actorId);
        if (!a?.lip) return;
        a.lip = { ...a.lip, ...patch };
        if (!a.lip.enabled) a.setMouth(null);
        this._applyLip(this.timeline.current);
        this._scheduleHistory();
    }

    _lipTimeline(text, duration) {
        const key = `${duration}|${text}`;
        if (this._lipCache?.key !== key) this._lipCache = { key, tl: buildVisemeTimeline(text, duration) };
        return this._lipCache.tl;
    }

    // 口パクに使う音声トラック(分割したクリップを含む)。lip.audio: 未指定 = 1 本目 / "none" = 使わない / トラック id
    lipClips(actor) {
        const want = actor.lip?.audio;
        if (want === "none") return [];
        const track = (want && this.audios.find(c => c.track === want || c.id === want)?.track) || this.audios[0]?.track;
        return this.audios.filter(c => c.track === track);
    }

    lipClip(actor) { return this.lipClips(actor)[0] ?? null; }

    _applyLip(frame) {
        for (const a of this.actors()) {
            if (!a.lip?.enabled) continue;
            const sec = frame / this.timeline.fps;
            const clips = this.lipClips(a);
            // その時刻に鳴っているクリップ(なければ先頭)
            const clip = clips.find(c => sec >= c.offset && sec < c.offset + clipLength(c)) ?? clips[0];
            const rt = clip ? this._clips.get(clip.id) : null;
            const local = sec - (clip?.offset || 0);
            const t = local + (clip?.trim || 0); // 元のファイルの中の時刻
            const env = rt?.env;
            const text = (a.lip.text || "").trim();
            let level, duration;
            if (env) {
                duration = env.duration;
                // 前後 1 サンプル(±20ms)を平均して細かい揺れを抑える。切り取った範囲の外は無音
                const i = local >= 0 && local < clipLength(clip) ? Math.floor(t * env.rate) : -10;
                let sum = 0, cnt = 0;
                for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < env.env.length) { sum += env.env[j]; cnt++; }
                level = cnt ? Math.min(1, (sum / cnt) * (a.lip.gain ?? 1.5)) : 0;
            } else if (text) {
                duration = estimateSpeechDuration(text);
                level = t >= 0 && t < duration ? LIP_TEXT_LEVEL : 0;
            } else {
                a.setMouth(null);
                continue;
            }
            const out = {};
            // 母音の決め方: auto = 音声があれば音声から判定、なければセリフから / audio / text / open(開閉だけ)
            const mode = a.lip.vowels ?? "auto";
            const vw = rt?.vowels;
            const useAudio = env && vw && (mode === "audio" || (mode === "auto"));
            const useText = text && !useAudio && mode !== "open";
            if (useAudio) {
                const i = Math.floor(t * vw.rate);
                if (i >= 0 && i < vw.weights.length / 5) MOUTH_VISEMES.forEach((v, k) => { out[v] = level * vw.weights[i * 5 + k]; });
            } else if (useText) {
                const u = this._lipTimeline(text, duration).units.find(x => t >= x.t0 && t < x.t1);
                if (u?.v) out[u.v] = level * Math.min(1, (t - u.t0) / LIP_FADE, (u.t1 - t) / LIP_FADE);
            } else {
                // セリフが無いときは音量だけで「あ」と「お」を混ぜて開閉する
                out.aa = level * 0.8;
                out.oh = level * 0.3;
            }
            for (const v of MOUTH_VISEMES) out[v] ??= 0;
            a.setMouth(out);
        }
    }

    // ================================================================ playback

    // render: 書き出し用。選択中のカメラではなく必ずカットのカメラから見る
    applyFrame(frame, { render = false } = {}) {
        const tl = this.timeline;
        // 子トラック(目など)は本体のポーズより後に当てる
        const channels = [];
        for (const id of Object.keys(tl.tracks)) {
            if (id === CUT_TRACK) continue;
            const { owner, ch } = parseTrack(id);
            if (ch) { channels.push([owner, ch, id]); continue; }
            const st = tl.evaluate(id, frame);
            if (!st) continue;
            if (this.cams.has(id)) this.cams.get(id).state = withDof(structuredClone(st));
            else if (id === SCENE_TRACK || id === WIND_TRACK) this.env.setAnimState(st);
            else this.objects.get(id)?.setState(st);
        }
        for (const [owner, ch, id] of channels) this.objects.get(owner)?.setChannel?.(ch, tl.evaluate(id, frame));
        const prev = tl.current;
        tl.current = frame;
        this._updateView(render);
        tl.current = prev;
        this.vp.setCameraState(this.cams.get(this.cams.viewId).state);
        this._applyLip(frame);
    }

    seek(frame, { resetPhysics = true } = {}) {
        const tl = this.timeline;
        tl.current = Math.max(0, Math.min(tl.frames, frame));
        this.applyFrame(tl.current);
        if (resetPhysics && !this.playing) for (const a of this.actors()) a.resetPhysics();
        this.env.syncVideo(tl.current / tl.fps, this.playing);
        this._syncAudio(false);
        if (tl.hasKeys(SCENE_TRACK) || tl.hasKeys(WIND_TRACK)) this._emit("env");
        this._emit("frame");
        this._emit("edited");
    }

    play(v = !this.playing) {
        if (v === this.playing) return;
        this.playing = v;
        const [s, e] = this.timeline.playRange();
        if (v && (this.timeline.current >= e - 0.5 || this.timeline.current < s)) this.timeline.current = s;
        this.vp.transform.enabled = !v;
        this._updateView();
        this._syncAudio(true);
        if (!v) this.seek(Math.round(this.timeline.current), { resetPhysics: false });
        this._emit("playing");
    }

    _update(dt) {
        const tl = this.timeline;
        if (this.playing) {
            const [s, e] = tl.playRange();
            let f = tl.current + dt * tl.fps;
            let looped = false;
            if (f >= e) {
                if (this.loop) { f = s + ((f - s) % Math.max(1, e - s)); looped = true; }
                else { f = e; this.play(false); }
            }
            tl.current = f;
            // 音声の頭出しは、時刻を巻き戻した後で行う(先に行うと終端の時刻で判定され、音声が止まったままになる)
            if (looped) this._syncAudio(true, true);
            this.applyFrame(f);
            this.env.syncVideo(f / tl.fps, true);
            this._emit("frame");
        } else {
            this._applyLip(tl.current);
        }
        // 風: 再生中・書き出し中はタイムラインの時刻、停止中は実時間でゆらぐ
        const w = this.env.state.wind;
        let wind = null;
        if (w?.enabled) {
            this._windClock = (this._windClock ?? 0) + dt;
            const t = this.playing || this.vp._paused ? tl.current / tl.fps : this._windClock;
            wind = windVector(w, t, this._wind ??= new THREE.Vector3());
        }
        for (const a of this.actors()) a.applyWind(wind);
        // まばたき: 風と同じく、再生中・書き出し中はタイムラインの時刻、停止中は実時間
        this._blinkClock = (this._blinkClock ?? 0) + dt;
        const bt = this.playing || this.vp._paused ? tl.current / tl.fps : this._blinkClock;
        for (const a of this.actors()) a.applyBlink(bt);
        for (const a of this.actors()) a.lookAtObject = this._lookAtObject(a);
        for (const o of this.objects.values()) o.update(dt);
        this.cams.updateHelpers();
    }

    // 風のつまみと矢印の表示(ポーズ付けの邪魔になるとき隠す)。このブラウザに覚えておく
    setWindHelperVisible(v) {
        this.env.windHelperVisible = v;
        this.env._placeWind(true);
        if (this.selection?.id === WIND_TRACK) this._attachGizmo();
        try { localStorage.setItem("vps:windHelper", v ? "1" : "0"); } catch { /* ignore */ }
        this._emit("wind-helper");
    }

    // 視線の先の目印(小さな球)を顔の前に置き、その人物の視線の先にする。動かせば目で追う
    async addLookAtMarker(actorId, name) {
        const a = this.objects.get(actorId);
        if (!a?.vrm) return null;
        const head = a.vrm.humanoid.getRawBoneNode("head") ?? a.root;
        head.updateWorldMatrix(true, false);
        const p = head.getWorldPosition(new THREE.Vector3());
        const front = (a.vrm.lookAt?.faceFront?.clone() ?? new THREE.Vector3(0, 0, 1))
            .applyQuaternion(a.vrm.scene.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
        p.addScaledVector(front, 0.8);
        const s = 0.12; // 直径 6cm(球の元の半径は 0.25)
        // 球は底面が原点なので、中心が目の高さに来るよう半径ぶん下げる
        p.y -= 0.25 * s;
        const m = await this.addObject({
            type: "prop", name, color: "#00d0d0", castShadow: false,
            src: { kind: "primitive", shape: "sphere" },
            transform: { p: p.toArray(), q: [0, 0, 0, 1], s: [s, s, s] },
        }, { record: false });
        a.lookAtTarget = m.id;
        this.editChannel(actorId, "eyes");
        this._afterEdit({ key: false });
        return m;
    }

    // 視線の先の Object3D。人物なら頭(目の高さ)を見る
    _lookAtObject(actor) {
        const id = actor.lookAtTarget;
        if (!id) return null;
        if (id === "camera") return this.vp.camera;
        const o = this.objects.get(id);
        if (!o || o === actor) return null;
        // プロップは中身(図形なら中心)を見る
        return o.type === "actor" ? (o.vrm.humanoid.getRawBoneNode("head") ?? o.root) : (o.content ?? o.root);
    }

    // ---- 音声トラック(複数) ----
    // this.audios が保存・Undo の対象。再生用の <audio> と解析結果(音量・母音)は this._clips に持つ。
    // 書き出しでは、ミュートしていないトラックをサーバー(ffmpeg)で重ねる
    audioClip(id) { return this.audios.find(c => c.id === id) ?? null; }

    // 解析(口パク用の音量・母音)がすべて終わるまで待つ(書き出しの前に使う)
    get _audioReady() { return Promise.all([...this._clips.values()].map(rt => rt.ready)); }

    // 保存データ → クリップ。track = タイムラインの行(分割したクリップは同じ行に並ぶ)
    _makeClip(d) {
        const clip = {
            id: d.id || newId("aud"), name: d.name ?? "audio", url: d.url, source: d.source ?? "local", path: d.path,
            offset: d.offset ?? 0, trim: d.trim ?? 0, length: d.length ?? null, duration: d.duration ?? 0,
            volume: d.volume ?? 1, muted: !!d.muted,
        };
        clip.track = d.track || clip.id;
        // 旧形式: 0 より前に置かれていた分は、頭を切り取ったことにして 0 から始める
        if (clip.offset < 0) {
            clip.trim += -clip.offset;
            if (clip.length != null) clip.length = Math.max(0, clip.length + clip.offset);
            clip.offset = 0;
        }
        return clip;
    }

    async addAudio(a, { record = true } = {}) {
        const clip = this._makeClip(a);
        this.audios.push(clip);
        await this._loadClip(clip);
        this._emit("audios");
        this._emit("timeline");
        if (record) this._scheduleHistory();
        return clip;
    }

    async _loadClip(clip) {
        const el = new Audio();
        el.preload = "auto";
        el.src = clip.url;
        const rt = { el, env: null, vowels: null, timer: null, ready: null };
        this._clips.set(clip.id, rt);
        await new Promise(res => {
            el.addEventListener("loadedmetadata", res, { once: true });
            el.addEventListener("error", res, { once: true });
        });
        clip.duration = el.duration || clip.duration || 0;
        this._applyVolume(clip);
        // 口パク用に音量と母音の時系列を先に解析しておく(書き出しでも同じ値を使う)。
        // 同じファイルを分割したクリップどうしは解析結果を使い回す
        this._analysis ??= new Map();
        if (!this._analysis.has(clip.url)) {
            this._analysis.set(clip.url, fetch(clip.url).then(r => r.blob()).then(blob => Promise.all([
                analyzeAudioFile(blob),
                analyzeVowels(blob).catch(e => { console.warn("[VPS] vowel analysis failed", e); return null; }),
            ])).catch(e => { this._analysis.delete(clip.url); throw e; }));
        }
        rt.ready = this._analysis.get(clip.url).then(([env, vowels]) => {
            if (this._clips.get(clip.id) !== rt) return;
            rt.env = env; rt.vowels = vowels;
            this._applyLip(this.timeline.current);
            this._emit("timeline");
        }).catch(e => console.warn("[VPS] audio analysis failed", e));
        if (this.playing) this._syncClip(clip, true);
    }

    _disposeClip(id) {
        const rt = this._clips.get(id);
        if (!rt) return;
        clearTimeout(rt.timer);
        rt.el.pause();
        rt.el.removeAttribute("src");
        this._clips.delete(id);
    }

    removeAudio(id) {
        if (!this.audioClip(id)) return;
        this._disposeClip(id);
        this.audios = this.audios.filter(c => c.id !== id);
        this._applyLip(this.timeline.current);
        this._emit("audios");
        this._emit("timeline");
        this._scheduleHistory();
    }

    // トラック(行)の一覧 [{ track, name, clips, muted, volume }]。分割したクリップは 1 つのトラックにまとまる
    audioTracks() {
        const m = new Map();
        for (const c of this.audios) (m.get(c.track) ?? m.set(c.track, []).get(c.track)).push(c);
        return [...m].map(([track, clips]) => ({ track, name: clips[0].name, clips, muted: clips.every(c => c.muted), volume: clips[0].volume ?? 1 }));
    }

    // トラック(行)ごとに外す・ミュートする。分割したクリップをまとめて扱う
    removeAudioTrack(track) {
        for (const c of this.audios.filter(c => c.track === track)) this._disposeClip(c.id);
        this.audios = this.audios.filter(c => c.track !== track);
        this._applyLip(this.timeline.current);
        this._emit("audios");
        this._emit("timeline");
        this._scheduleHistory();
    }

    setAudioTrackProps(track, patch) {
        for (const c of this.audios.filter(c => c.track === track)) this.setAudioProps(c.id, patch);
    }

    // sec(タイムラインの秒)でクリップを 2 つに分ける。後ろ半分は新しいクリップ(同じ行)になる
    async splitAudio(id, sec) {
        const clip = this.audioClip(id);
        if (!clip) return null;
        const len = clipLength(clip);
        const local = sec - clip.offset;
        if (local < MIN_CLIP || local > len - MIN_CLIP) return null;
        const d = { ...clip, id: newId("aud"), offset: sec, trim: (clip.trim || 0) + local, length: len - local };
        clip.length = local;
        const next = this._makeClip(d);
        this.audios.splice(this.audios.indexOf(clip) + 1, 0, next);
        await this._loadClip(next);
        if (this.playing) this._syncClip(clip, true);
        this._emit("audios");
        this._emit("timeline");
        this._scheduleHistory();
        return next;
    }

    // patch: { offset, volume(0..1), muted, name } の一部
    setAudioProps(id, patch) {
        const clip = this.audioClip(id);
        if (!clip) return;
        if ("offset" in patch) patch = { ...patch, offset: Math.max(0, +patch.offset || 0) };
        Object.assign(clip, patch);
        this._applyVolume(clip);
        if ("offset" in patch && this.playing) this._syncClip(clip, true);
        this._applyLip(this.timeline.current);
        this._emit("audios");
        this._emit("timeline");
        this._scheduleHistory();
    }

    setAudioOffset(id, sec) { this.setAudioProps(id, { offset: sec }); }

    _applyVolume(clip) {
        const rt = this._clips.get(clip.id);
        if (rt) rt.el.volume = clip.muted ? 0 : Math.max(0, Math.min(1, clip.volume ?? 1));
    }

    // id で突き合わせ、同じファイルのトラックは読み込み直さずに設定だけ更新する(undo でも使う)
    async _loadAudios(list) {
        const wanted = new Map(list.filter(c => c?.url).map(c => [c.id, c]));
        for (const c of this.audios) if (!wanted.has(c.id) || wanted.get(c.id).url !== c.url) this._disposeClip(c.id);
        const keep = new Map(this.audios.filter(c => this._clips.has(c.id)).map(c => [c.id, c]));
        this.audios = [];
        for (const d of wanted.values()) {
            const cur = keep.get(d.id);
            if (cur) {
                const { offset, trim, length, track } = this._makeClip(d);
                Object.assign(cur, { name: d.name ?? cur.name, offset, trim, length, track, volume: d.volume ?? 1, muted: !!d.muted });
                this.audios.push(cur);
                this._applyVolume(cur);
            } else {
                const clip = this._makeClip(d);
                this.audios.push(clip);
                await this._loadClip(clip);
            }
        }
        this._emit("audios");
    }

    _syncAudio(force, restart) {
        for (const clip of this.audios) this._syncClip(clip, force || restart);
    }

    _syncClip(clip, force) {
        const rt = this._clips.get(clip.id);
        if (!rt) return;
        const el = rt.el;
        if (!this.playing) { clearTimeout(rt.timer); el.pause(); return; }
        if (!force) return;
        // 前のループで予約した開始待ち・停止が残っていると、二重に頭出しされるので取り消す
        clearTimeout(rt.timer);
        const t = this.timeline.current / this.timeline.fps - (clip.offset || 0);
        const len = clipLength(clip) || Infinity;
        if (t >= 0 && t < len) {
            el.currentTime = (clip.trim || 0) + t;
            el.play().catch(() => {});
            // 切り取った終わりで止める
            if (isFinite(len)) rt.timer = setTimeout(() => el.pause(), (len - t) * 1000);
        } else {
            el.pause();
            // 開始前なら、始まる時刻に再生を予約
            if (t < 0) rt.timer = setTimeout(() => this.playing && this._syncClip(clip, true), -t * 1000);
        }
    }

    // ================================================================ output / env

    setOutputSize(w, h) {
        this.output = { width: Math.max(64, Math.round(w)), height: Math.max(64, Math.round(h)) };
        this.vp.setOutputSize(this.output.width, this.output.height);
        this._emit("output");
        this._scheduleHistory();
    }

    async setEnv(patch) {
        const next = structuredClone(this.env.state);
        for (const [k, v] of Object.entries(patch)) next[k] = typeof v === "object" && v && !Array.isArray(v) ? { ...next[k], ...v } : v;
        await this.env.apply(next);
        if (this.autoKey && (this.selection?.id === SCENE_TRACK || this.selection?.id === WIND_TRACK)) {
            // 風は別のトラック
            if (patch.wind) this.keyTrack(WIND_TRACK);
            if (Object.keys(patch).some(k => k !== "wind")) this.keyTrack(SCENE_TRACK);
        }
        // 風を切ったらつまみからギズモを外す(入れたら付ける)
        if (patch.wind && this.selection?.id === WIND_TRACK) this._attachGizmo();
        this._emit("env");
        this._scheduleHistory();
    }

    // ================================================================ serialize

    // withRegional: undo の履歴にはリージョン設定を入れない(リージョンタブの編集が undo で巻き戻らないように)
    serialize({ withCamera = true, withRegional = withCamera } = {}) {
        // アタッチ先の人物が先に作られるよう、プロップ(子)は後ろに並べる
        const objs = this.list().map(o => o.serialize());
        objs.sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
        return {
            app: "vrm-pose-studio",
            version: PROJECT_VERSION,
            name: this.projectName,
            output: { ...this.output },
            env: structuredClone(this.env.state),
            camera: withCamera ? this.vp.getCameraState() : undefined,
            cameras: this.cams.serialize().map(c => (withCamera ? c : { ...c, state: undefined })),
            objects: objs,
            order: [...this.objects.keys()],
            timeline: this.timeline.serialize(),
            audios: this.audios.map(c => ({ ...c })),
            regional: withRegional ? structuredClone(this.regional) : undefined,
        };
    }

    // 既存オブジェクトは id で突き合わせて状態だけ更新し、足りないものは読み込む(undo でも使う)
    async load(project, { camera = true, regional = camera } = {}) {
        const wanted = new Map((project.objects ?? []).map(o => [o.id, o]));
        for (const id of [...this.objects.keys()]) {
            const o = this.objects.get(id);
            const w = wanted.get(id);
            if (!w || w.src?.url !== o.src?.url || w.src?.shape !== o.src?.shape || w.src?.kind !== o.src?.kind || w.type !== o.type) {
                for (const c of this.list()) if (c.parentRef?.actorId === id) { this.vp.scene.attach(c.root); c.parentRef = null; }
                o.dispose();
                this.objects.delete(id);
            }
        }
        const failed = [];
        for (const d of project.objects ?? []) {
            let o = this.objects.get(d.id);
            if (!o) {
                try {
                    o = await createObject(d);
                } catch (e) {
                    console.warn("[VPS] failed to load object", d, e);
                    failed.push(d.name || d.id);
                    continue;
                }
                this.objects.set(o.id, o);
                this.vp.scene.add(o.root);
                if (o.type === "actor") { this.vp.helpers.add(o.handles); o.setFingerHandlesVisible(this.showFingers); }
            }
            o.name = d.name; o.root.name = d.name;
            o.locked = !!d.locked;
            if (o.type === "actor") { o.springBone = d.springBone ?? true; o.lookAtTarget = d.lookAtTarget ?? (d.lookAtCamera ? "camera" : ""); o.lip = { ...o.lip, ...(d.lip ?? { enabled: false }) }; o.setBlink(d.blink ?? { enabled: false }); }
            else if (o.type === "light") { o.castShadow = !!d.castShadow; o.applyLight(); }
            else { o.color = d.color ?? o.color; o.opacity = d.opacity ?? 1; o.castShadow = d.castShadow ?? true; o.applyMaterial(); }
            const curRef = JSON.stringify(o.parentRef ?? null), newRef = JSON.stringify(d.parent ?? null);
            if (curRef !== newRef) {
                if (o.parentRef) { this.vp.scene.add(o.root); o.parentRef = null; }
                if (d.parent) this._attach(o, d.parent, false);
            }
            o.setState(d);
        }
        if (project.order) {
            const m = new Map();
            for (const id of project.order) if (this.objects.has(id)) m.set(id, this.objects.get(id));
            for (const [id, o] of this.objects) if (!m.has(id)) m.set(id, o);
            this.objects = m;
        }
        this.projectName = project.name ?? this.projectName;
        if (project.output) { this.output = { ...project.output }; this.vp.setOutputSize(this.output.width, this.output.height); }
        await this.env.apply(project.env ?? DEFAULT_ENV);
        // 旧プロジェクト(カメラ 1 台)は camera の視点を既定のカメラとして引き継ぐ
        const camList = project.cameras?.length ? project.cameras
            : [{ id: CAMERA_TRACK, name: "Camera 1", state: project.camera ?? this.cams.get(CAMERA_TRACK)?.state }];
        this.cams.load(camList, { keepStates: !camera });
        this.timeline.load(project.timeline);
        this._migrateTracks();
        if (regional) { this.regional = project.regional ?? null; this._emit("regional"); }
        // 旧プロジェクトは音声 1 本(project.audio)
        await this._loadAudios(project.audios ?? (project.audio?.url ? [{ ...project.audio, id: "audio" }] : []));
        if (this.selection && !this.cams.has(this.selection.id) && this.selection.id !== SCENE_TRACK && this.selection.id !== WIND_TRACK && !this.objects.has(this.selection.id)) this.selection = null;
        this.select(this.selection?.id, this.selection?.bone);
        for (const a of this.actors()) a.resetPhysics();
        this._emit("objects"); this._emit("cameras"); this._emit("env"); this._emit("output"); this._emit("timeline"); this._emit("frame"); this._emit("edited");
        return { failed };
    }

    // 旧形式のキーを子トラックへ分ける: 人物の本体のキーにあった視線(lookAtCamera)・まばたき(blink) → eyes / blink、
    // 背景・ライトのキーにあった風 → wind。値が変わらない(既定のまま)なら子トラックは作らない
    _migrateTracks() {
        const tl = this.timeline;
        const split = (from, to, pick, keep) => {
            const keys = (tl.tracks[from] ?? []).map(k => ({ frame: k.frame, ease: k.ease, state: pick(k.state) })).filter(k => k.state !== undefined);
            if (keys.length && keep(keys.map(k => k.state)) && !tl.hasKeys(to)) tl.tracks[to] = keys;
        };
        for (const a of this.actors()) {
            split(a.id, channelTrack(a.id, "eyes"), s => s.lookAtCamera === undefined ? undefined : { lookAt: s.lookAtCamera ? "camera" : "" }, v => v.some(x => x?.lookAt));
            split(a.id, channelTrack(a.id, "blink"), s => s.blink ? { blink: s.blink } : undefined, v => v.some(x => x?.blink.enabled));
            for (const k of tl.keys(a.id)) { delete k.state.lookAtCamera; delete k.state.blink; }
        }
        const env = this.env.state.wind;
        split(SCENE_TRACK, WIND_TRACK, s => s.wind ? { wind: { enabled: env.enabled, ...s.wind } } : undefined,
            v => v.some(x => JSON.stringify(x.wind) !== JSON.stringify(v[0].wind)));
        for (const k of tl.keys(SCENE_TRACK)) delete k.state.wind;
    }

    async newProject() {
        await this.load({ name: "untitled", objects: [], env: DEFAULT_ENV, timeline: {}, audio: null, regional: null, output: { width: 1024, height: 1024 },
            cameras: [{ id: CAMERA_TRACK, name: "Camera 1", state: { position: [0, 1.2, 4.2], target: [0, 0.95, 0], fov: 35 } }] });
        this.resetHistory();
    }

    // ================================================================ history

    _snapshot() { return JSON.stringify(this.serialize({ withCamera: false })); }

    _pushHistory() {
        const s = this._snapshot();
        if (this._history[this._history.length - 1] === s) return;
        this._history.push(s);
        if (this._history.length > HISTORY_LIMIT) this._history.shift();
        this._future = [];
        this._emit("history");
    }

    _scheduleHistory() {
        clearTimeout(this._histTimer);
        this._histTimer = setTimeout(() => this._pushHistory(), 250);
    }

    resetHistory() { this._history = []; this._future = []; this._pushHistory(); this.markSaved(); }
    markSaved() { this._savedSnap = this._snapshot(); }
    isDirty() { return this.objects.size > 0 && this._snapshot() !== this._savedSnap; }
    get canUndo() { return this._history.length > 1; }
    get canRedo() { return this._future.length > 0; }

    async undo() {
        clearTimeout(this._histTimer);
        this._pushHistory();
        if (!this.canUndo) return;
        this._future.push(this._history.pop());
        await this.load(JSON.parse(this._history[this._history.length - 1]), { camera: false });
        this._emit("history");
    }

    async redo() {
        if (!this.canRedo) return;
        const s = this._future.pop();
        this._history.push(s);
        await this.load(JSON.parse(s), { camera: false });
        this._emit("history");
    }

    // ================================================================ capture

    async captureStill({ width = this.output.width, height = this.output.height, mask = false } = {}) {
        const transparent = mask || this.env.transparentBackground;
        // モニター中の静止画・サムネイルは、モニターではなくカメラ(_shotCamera)から撮る
        const monitorView = this.cams.viewId === MONITOR;
        // 視点の切り替えも見えないよう、撮り終えて元の画面を描き直すまで画像を重ねておく(書き出し中は exporter が重ねている)
        const ownFreeze = !this.vp._freezeEl;
        if (ownFreeze) this.vp.freeze(true);
        if (monitorView) this.cams.setView(this._shotCamera());
        try {
            return await this._capture(width, height, mask, transparent);
        } finally {
            if (monitorView) this.cams.setView(MONITOR);
            if (ownFreeze) { this.vp._render(); this.vp.freeze(false); }
        }
    }

    _capture(width, height, mask, transparent) {
        return this.vp.capture(width, height, {
            transparent,
            postFx: !mask, // マスクはぼかさない(生成側でくっきりした輪郭を使うため)
            preview: !mask,
            prepare: on => {
                if (mask) this.env.setMaskMode(on);
                this._hideHelpers(on);
            },
        });
    }

    _hideHelpers(on) {
        const t = this.vp.transform;
        if (on) { this._tVis = t.visible; t.visible = false; } else t.visible = this._tVis ?? true;
    }

    // リージョン用: 物体ごとのシルエット(アルファ)を本番カメラから撮る。手前の物に隠れた部分も含む(重なりはリージョン側で決める)
    // 戻り値 [{ id, name, type, depth(カメラからの距離), alpha(Uint8ClampedArray w*h), bbox: { x0, y0, x1, y1 }(px, x1/y1 は含まない) }]
    async captureObjectMasks({ width = this.output.width, height = this.output.height } = {}) {
        const targets = this.list().filter(o => o.type !== "light" && o.visible);
        // 各メッシュの持ち主(いちばん近い祖先の SceneObject)。アタッチされたプロップは人物のボーンの下にあるので、root の表示切替ではなくメッシュ単位で隠す
        const owned = new Map(targets.map(o => [o, []]));
        const allMeshes = [];
        for (const o of this.list()) {
            o.root.traverse(n => {
                if (!(n.isMesh || n.isSkinnedMesh || n.isPoints || n.isLine || n.isSprite)) return;
                let p = n;
                while (p && !p.userData.vpsObject) p = p.parent;
                allMeshes.push(n);
                if (p?.userData.vpsObject && owned.has(p.userData.vpsObject)) owned.get(p.userData.vpsObject).push(n);
            });
        }
        const monitorView = this.cams.viewId === MONITOR;
        const ownFreeze = !this.vp._freezeEl;
        if (ownFreeze) this.vp.freeze(true);
        if (monitorView) this.cams.setView(this._shotCamera());
        const saved = new Map(allMeshes.map(m => [m, m.visible]));
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const out = [];
        try {
            const camPos = this.vp.camera.getWorldPosition(new THREE.Vector3());
            for (const o of targets) {
                const mine = new Set(owned.get(o));
                if (!mine.size) continue;
                for (const m of allMeshes) m.visible = mine.has(m) && saved.get(m);
                const blob = await this._capture(width, height, true, true);
                const bmp = await createImageBitmap(blob);
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(bmp, 0, 0);
                bmp.close?.();
                const data = ctx.getImageData(0, 0, width, height).data;
                const alpha = new Uint8ClampedArray(width * height);
                let x0 = width, y0 = height, x1 = -1, y1 = -1;
                for (let y = 0, i = 0; y < height; y++) {
                    for (let x = 0; x < width; x++, i++) {
                        const a = data[i * 4 + 3];
                        if (a < 8) continue;
                        alpha[i] = a;
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
                if (x1 < 0) continue; // 画面に映っていない
                const box = new THREE.Box3();
                for (const m of mine) box.expandByObject(m);
                const depth = box.isEmpty() ? o.root.getWorldPosition(new THREE.Vector3()).distanceTo(camPos) : box.getCenter(new THREE.Vector3()).distanceTo(camPos);
                out.push({ id: o.id, name: o.name, type: o.type, depth, alpha, bbox: { x0, y0, x1: x1 + 1, y1: y1 + 1 } });
            }
        } finally {
            for (const [m, v] of saved) m.visible = v;
            if (monitorView) this.cams.setView(MONITOR);
            if (ownFreeze) { this.vp._render(); this.vp.freeze(false); }
        }
        return out;
    }

    async thumbnail(size = 320) {
        const a = this.output.width / this.output.height;
        const w = a >= 1 ? size : Math.round(size * a), h = a >= 1 ? Math.round(size / a) : size;
        return this.captureStill({ width: w, height: h });
    }
}

export { CAMERA_TRACK, CUT_TRACK, THREE };
