// objects.js — シーンに置くオブジェクト(VRM アクター / プロップ)
//
// どちらも root(THREE.Group) を持ち、root のローカル変換が「オブジェクトの変換」になる。
// プロップはアクターのボーンにアタッチでき、そのときローカル変換はボーン基準になる。
// getState()/setState() はキーフレーム補間の単位、serialize() はプロジェクト保存の単位。

import * as THREE from "../../vendor/three.module.js";
import { GLTFLoader } from "../../vendor/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneList } from "../../vendor/three-vrm.module.js";
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } from "../../vendor/three-vrm-animation.module.js";
import { HELPER_LAYER } from "./viewport.js";
import { fbxToClip } from "../lib/fbx_retarget.js";

let _seq = 0;
export function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${(_seq++).toString(36)}`;
}

function vrmLoader() {
    const l = new GLTFLoader();
    l.register(p => new VRMLoaderPlugin(p));
    return l;
}

function transformOf(o) {
    return { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() };
}

function applyTransform(o, t) {
    if (!t) return;
    if (t.p) o.position.fromArray(t.p);
    if (t.q) o.quaternion.fromArray(t.q);
    if (t.s) o.scale.fromArray(t.s);
}

class SceneObject {
    constructor(type, opts) {
        this.type = type;
        this.id = opts.id || newId(type);
        this.name = opts.name || type;
        this.src = opts.src || {};
        this.root = new THREE.Group();
        this.root.name = this.name;
        this.root.userData.vpsObject = this;
        this.parentRef = null; // { actorId, bone } (プロップのみ)
        this.locked = false;
    }
    get visible() { return this.root.visible; }
    set visible(v) { this.root.visible = !!v; }

    getState() {
        return { transform: transformOf(this.root), visible: this.root.visible };
    }
    setState(s) {
        if (!s) return;
        applyTransform(this.root, s.transform);
        if (s.visible !== undefined) this.root.visible = s.visible;
    }
    serialize() {
        return {
            id: this.id, type: this.type, name: this.name, src: this.src,
            locked: this.locked, parent: this.parentRef, ...this.getState(),
        };
    }
    pickTargets() { return [this.root]; }
    update() {}
    dispose() {
        this.root.removeFromParent();
        this.root.traverse(o => {
            o.geometry?.dispose?.();
            const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
            mats.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
        });
    }
}

// ================================================================ Actor (VRM)

// .vroidpose(VRoid Studio)のボーン名 → VRM ヒューマノイド名と、レスト姿勢の差を埋める X 軸補正(度)。
// 値は 3D Pose Editor(pose_editor_core.js)と同じ
const VROID_TO_VRM = {
    Hips: "hips", Spine: "spine", Chest: "chest", UpperChest: "upperChest", Neck: "neck", Head: "head",
    LeftShoulder: "leftShoulder", LeftUpperArm: "leftUpperArm", LeftLowerArm: "leftLowerArm", LeftHand: "leftHand",
    RightShoulder: "rightShoulder", RightUpperArm: "rightUpperArm", RightLowerArm: "rightLowerArm", RightHand: "rightHand",
    LeftUpperLeg: "leftUpperLeg", LeftLowerLeg: "leftLowerLeg", LeftFoot: "leftFoot", LeftToes: "leftToes",
    RightUpperLeg: "rightUpperLeg", RightLowerLeg: "rightLowerLeg", RightFoot: "rightFoot", RightToes: "rightToes",
};
const VROID_CORRECTION_X = { Spine: 10, Chest: -18, UpperChest: -9, Neck: 15, LeftUpperLeg: 2, RightUpperLeg: 2, LeftShoulder: 16, RightShoulder: 16 };
const VROID_CORRECTION_X_VRM1 = { Spine: -10, Chest: 18, UpperChest: 9, Neck: -15, LeftUpperLeg: -2, RightUpperLeg: -2, LeftShoulder: -16, RightShoulder: -16 };

const HANDLE_OPACITY = 0.85; // 関節ハンドルの既定の不透明度
export const MOUTH_VISEMES = ["aa", "ih", "ou", "ee", "oh"];
export const EYE_BONES = ["leftEye", "rightEye"];

// 自動まばたき: 閉じる・閉じたまま・開く の秒数(3D Pose Editor と同じ)
const BLINK_CLOSE = 0.06, BLINK_HOLD = 0.04, BLINK_OPEN = 0.10;

// k 番目のまばたきの開始時刻のずれ(間隔の ±25%)。k から決まる疑似乱数なので毎回同じになる
function blinkJitter(k) {
    const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
    return (x - Math.floor(x) - 0.5) * 0.5;
}

// 時刻 t(秒)の "blink" の重み。時刻だけで決まるので、再生と書き出しで同じフレームには同じまばたきが出る
function blinkWeightAt(t, interval) {
    const iv = Math.max(0.5, interval);
    const k0 = Math.floor(t / iv);
    let w = 0;
    for (let k = k0 - 1; k <= k0 + 1; k++) {
        const d = t - (k + 0.5 + blinkJitter(k)) * iv;
        if (d < 0 || d > BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN) continue;
        if (d < BLINK_CLOSE) w = Math.max(w, d / BLINK_CLOSE);
        else if (d < BLINK_CLOSE + BLINK_HOLD) w = 1;
        else w = Math.max(w, 1 - (d - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN);
    }
    return w;
}

const CENTER_BONES = new Set(["hips", "spine", "chest", "upperChest", "neck", "head", "jaw"]);
const FINGER_RE = /(Thumb|Index|Middle|Ring|Little)/;

export class Actor extends SceneObject {
    static async load(opts) {
        const gltf = await vrmLoader().loadAsync(opts.src.url);
        const vrm = gltf.userData.vrm;
        if (!vrm) throw new Error("VRM data not found (not a .vrm file?)");
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        VRMUtils.rotateVRM0(vrm);
        return new Actor(opts, vrm);
    }

    constructor(opts, vrm) {
        super("actor", opts);
        this.vrm = vrm;
        this.root.add(vrm.scene);
        vrm.scene.traverse(o => {
            if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
        });
        this.springBone = true;
        // 視線の先: "" = なし / "camera" = 見ているカメラ / それ以外 = シーンのオブジェクトの id(人物なら頭)。
        // 実際の Object3D は studio が毎フレーム lookAtObject に入れる
        this.lookAtTarget = "";
        this.lookAtObject = null;
        // リップシンク: 音声トラックの音量(+ 任意のセリフ文字列の母音)で口形 aa/ih/ou/ee/oh を動かす
        this.lip = { enabled: false, text: "", gain: 1.5, vowels: "auto", audio: "" };
        // 自動まばたき。ON の間は表情 "blink" の手動の値を _blinkUser に持ち、描画ごとに max(手動, まばたき) を入れる
        this.blink = { enabled: false, interval: 4 };
        this._blinkUser = 0;
        // 人物ごとにまばたきの時刻をずらす(全員が同時に目を閉じないように)
        this._blinkPhase = [...this.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7) / 9973 * 60;
        this.isVrm0 = vrm.meta?.metaVersion === "0";

        const h = vrm.humanoid;
        this.bones = VRMHumanBoneList
            .map(name => ({ name, node: h.getNormalizedBoneNode(name), raw: h.getRawBoneNode(name) }))
            .filter(b => b.node && b.raw);
        this.restHips = h.normalizedRestPose?.hips?.position ?? [0, 0, 0];
        this.expressionNames = (vrm.expressionManager?.expressions ?? []).map(e => e.expressionName);

        // ---- 関節ハンドル(ヘルパーレイヤー。書き出しには写らない) ----
        this.handles = new THREE.Group();
        this.handles.name = `${this.name}-handles`;
        this.handles.visible = false;
        const geo = new THREE.SphereGeometry(1, 12, 8);
        for (const b of this.bones) {
            const side = b.name.startsWith("left") ? 0x4aa8ff : b.name.startsWith("right") ? 0xff6a6a : 0xffd24a;
            const mat = new THREE.MeshBasicMaterial({ color: side, depthTest: false, transparent: true, opacity: HANDLE_OPACITY });
            const m = new THREE.Mesh(geo, mat);
            m.renderOrder = 999;
            m.layers.set(HELPER_LAYER);
            const r = FINGER_RE.test(b.name) ? 0.008 : CENTER_BONES.has(b.name) ? 0.022 : 0.017;
            m.scale.setScalar(r);
            m.userData.baseColor = side;
            m.userData.baseScale = r;
            m.userData.bone = b;
            m.userData.actor = this;
            b.handle = m;
            this.handles.add(m);
        }
        this._showFingers = true;
    }

    // 関節ハンドルの濃さ(0..1。1 = 今までの見え方、0 = 完全に透明でクリックにも反応しない)
    setHandleOpacity(v) {
        for (const b of this.bones) {
            b.handle.material.opacity = HANDLE_OPACITY * v;
            b.handle.material.visible = v > 0.001;
        }
    }

    setFingerHandlesVisible(v) {
        this._showFingers = v;
        for (const b of this.bones) if (FINGER_RE.test(b.name)) b.handle.visible = v;
    }

    highlightBone(name) {
        for (const b of this.bones) {
            const on = b.name === name;
            b.handle.material.color.set(on ? 0xffffff : b.handle.userData.baseColor);
            b.handle.scale.setScalar(b.handle.userData.baseScale * (on ? 1.5 : 1));
        }
    }

    bone(name) { return this.bones.find(b => b.name === name); }

    update(dt) {
        const vrm = this.vrm;
        const target = this.lookAtTarget ? this.lookAtObject : null;
        if (vrm.lookAt) vrm.lookAt.target = target;
        // reset() は目のボーンを正面へ書き戻すので、視線の先を外した瞬間だけ呼ぶ
        // (毎フレーム呼ぶと手で回した目・キーフレームの目が上書きされて動かせない)
        if (vrm.lookAt && !target && this._lookAtWas) vrm.lookAt.reset?.();
        this._lookAtWas = !!target;
        if (this.springBone || !vrm.springBoneManager) {
            vrm.update(dt);
        } else {
            // 揺れ物を止める: 揺れ以外(ボーン・表情・視線)だけ更新する
            vrm.humanoid.update();
            vrm.lookAt?.update(dt);
            vrm.expressionManager?.update();
            vrm.nodeConstraintManager?.update();
        }
        if (this.handles.visible) {
            const v = new THREE.Vector3();
            for (const b of this.bones) b.handle.position.copy(b.raw.getWorldPosition(v));
        }
    }

    resetPhysics() {
        const m = this.vrm.springBoneManager;
        if (!m) return;
        // reset() は親ボーンの matrixWorld から揺れ物の初期位置を作るので、先に今のポーズを行列へ反映する
        // (しないと直前の画面更新の姿勢が混ざり、書き出しのたびに揺れ方が変わる)
        this.vrm.humanoid?.update();
        this.root.updateWorldMatrix(true, true);
        m.reset();
    }

    // ---- 風 ----
    // three-vrm に風の API は無いので、揺れ物の各ジョイントの重力(gravityDir × gravityPower)に風ベクトルを足して上書きする
    // (3D Pose Editor と同じ方式)。wind = null で元の重力に戻す
    applyWind(wind) {
        const joints = this.vrm.springBoneManager?.joints;
        if (!joints) return;
        if (!this._gravity) {
            this._gravity = new Map();
            joints.forEach(j => this._gravity.set(j, { dir: j.settings.gravityDir.clone(), power: j.settings.gravityPower }));
        }
        if (!wind && !this._windOn) return;
        const v = new THREE.Vector3();
        joints.forEach(j => {
            const g = this._gravity.get(j);
            if (!g) return;
            if (!wind) { j.settings.gravityDir.copy(g.dir); j.settings.gravityPower = g.power; return; }
            v.copy(g.dir).multiplyScalar(g.power).add(wind);
            const len = v.length();
            if (len > 1e-6) { j.settings.gravityDir.copy(v).divideScalar(len); j.settings.gravityPower = len; }
            else { j.settings.gravityDir.copy(g.dir); j.settings.gravityPower = 0; }
        });
        this._windOn = !!wind;
    }

    // ---- ポーズ ----
    getPose() {
        const bones = {};
        for (const b of this.bones) bones[b.name] = b.node.quaternion.toArray();
        const hp = this.bone("hips")?.node.position;
        return { bones, hips: hp ? [hp.x - this.restHips[0], hp.y - this.restHips[1], hp.z - this.restHips[2]] : [0, 0, 0] };
    }

    setPose(p) {
        if (!p) return;
        for (const b of this.bones) {
            const q = p.bones?.[b.name];
            if (q) b.node.quaternion.fromArray(q);
        }
        const hips = this.bone("hips")?.node;
        if (hips && p.hips) hips.position.set(this.restHips[0] + p.hips[0], this.restHips[1] + p.hips[1], this.restHips[2] + p.hips[2]);
    }

    resetPose() {
        this.vrm.humanoid.resetNormalizedPose();
    }

    // 左右反転。正規化ボーンはレストが全て単位回転なので、YZ 平面の鏡映は (x, -y, -z, w)
    mirrorPose() {
        const p = this.getPose();
        const out = { bones: {}, hips: [-p.hips[0], p.hips[1], p.hips[2]] };
        for (const [name, q] of Object.entries(p.bones)) {
            const other = name.startsWith("left") ? "right" + name.slice(4) : name.startsWith("right") ? "left" + name.slice(5) : name;
            out.bones[other] = [q[0], -q[1], -q[2], q[3]];
        }
        this.setPose(out);
    }

    // 3D Pose Editor の pose JSON(version 2: {bones:{name:{qx,qy,qz,qw,px?,py?,pz?}}, vrmVersion})と相互変換
    exportPoseJson() {
        const bones = {};
        const p = this.getPose();
        for (const [name, q] of Object.entries(p.bones)) bones[name] = { qx: q[0], qy: q[1], qz: q[2], qw: q[3] };
        if (bones.hips && Math.hypot(...p.hips) > 1e-6) Object.assign(bones.hips, { px: p.hips[0], py: p.hips[1], pz: p.hips[2] });
        return { version: 2, vrmVersion: this.vrm.meta?.metaVersion ?? null, bones };
    }

    importPoseJson(parsed) {
        // VRoid Studio の .vroidpose(BoneDefinition: Unity 左手系のローカル回転)。変換は 3D Pose Editor と同じ
        if (parsed?.BoneDefinition) {
            const bd = parsed.BoneDefinition;
            const corrTable = this.isVrm0 ? VROID_CORRECTION_X : VROID_CORRECTION_X_VRM1;
            const pose = { bones: {}, hips: [0, 0, 0] };
            const e = new THREE.Euler();
            for (const [vroidKey, vrmKey] of Object.entries(VROID_TO_VRM)) {
                const r = bd[vroidKey];
                if (!r) continue;
                const q = new THREE.Quaternion(r.x, r.y, -r.z, -r.w).normalize();
                if (!this.isVrm0) q.set(q.x, -q.y, q.z, -q.w).normalize();
                const corr = corrTable[vroidKey];
                if (corr) q.multiply(new THREE.Quaternion().setFromEuler(e.set(THREE.MathUtils.degToRad(corr), 0, 0)));
                pose.bones[vrmKey] = q.toArray();
            }
            if (!Object.keys(pose.bones).length) return false;
            this.resetPose();
            this.setPose(pose);
            return true;
        }
        // { boneName: { rotation: [x,y,z,w] } } 形式
        if (parsed && typeof parsed === "object" && Object.values(parsed).some(v => Array.isArray(v?.rotation))) {
            const pose = { bones: {} };
            for (const [name, v] of Object.entries(parsed)) if (Array.isArray(v?.rotation) && v.rotation.length === 4) pose.bones[name] = v.rotation;
            this.resetPose();
            this.setPose(pose);
            return true;
        }
        if (parsed?.version === 2 && parsed.bones) {
            const cur = this.vrm.meta?.metaVersion ?? null;
            const conv = parsed.vrmVersion != null && cur != null && parsed.vrmVersion !== cur;
            const pose = { bones: {}, hips: null };
            for (const [name, b] of Object.entries(parsed.bones)) {
                const q = new THREE.Quaternion(b.qx, b.qy, b.qz, b.qw);
                if (conv) q.set(q.x, -q.y, q.z, -q.w).normalize(); // VRM0↔VRM1: Y と W を反転(3D Pose Editor と同じ変換)
                pose.bones[name] = q.toArray();
                if (name === "hips" && b.px !== undefined) {
                    const s = conv ? -1 : 1;
                    pose.hips = [b.px * s, b.py, b.pz * s];
                }
            }
            this.resetPose();
            this.setPose({ ...pose, hips: pose.hips ?? [0, 0, 0] });
            return true;
        }
        // 旧形式(オイラー角)
        const bones = parsed?.bones ?? parsed;
        if (bones && typeof bones === "object") {
            const e = new THREE.Euler();
            const pose = { bones: {} };
            for (const [name, b] of Object.entries(bones)) {
                if (b && typeof b.x === "number") pose.bones[name] = new THREE.Quaternion().setFromEuler(e.set(b.x, b.y ?? 0, b.z ?? 0)).toArray();
            }
            if (Object.keys(pose.bones).length) { this.resetPose(); this.setPose(pose); return true; }
        }
        return false;
    }

    // ---- 表情 ----
    getExpressions() {
        const m = this.vrm.expressionManager;
        const out = {};
        if (!m) return out;
        for (const n of this.expressionNames) {
            const v = this.getExpression(n);
            if (v) out[n] = v;
        }
        return out;
    }

    setExpressions(map) {
        const m = this.vrm.expressionManager;
        if (!m || !map) return;
        for (const n of this.expressionNames) this.setExpression(n, map[n] ?? 0);
    }

    // 自動まばたき中の "blink" は、まばたきの途中の値ではなく手動の値を読み書きする
    getExpression(n) {
        if (n === "blink" && this.blink.enabled) return this._blinkUser;
        return this.vrm.expressionManager?.getValue(n) ?? 0;
    }

    setExpression(n, v) {
        if (n === "blink" && this.blink.enabled) this._blinkUser = v;
        this.vrm.expressionManager?.setValue(n, v);
    }

    hasBlink() { return !!this.vrm.expressionManager?.getExpression("blink"); }

    setBlink(patch) {
        if (!patch) return;
        if (typeof patch.interval === "number" && isFinite(patch.interval)) this.blink.interval = Math.max(0.5, patch.interval);
        if (typeof patch.enabled === "boolean" && patch.enabled !== this.blink.enabled) {
            const m = this.vrm.expressionManager;
            if (patch.enabled) this._blinkUser = m?.getValue("blink") ?? 0;
            else if (this.hasBlink()) m.setValue("blink", this._blinkUser);
            this.blink.enabled = patch.enabled;
        }
    }

    // t: 秒(再生・書き出し中はタイムラインの時刻、停止中は実時間)
    applyBlink(t) {
        if (!this.blink.enabled || !this.hasBlink()) return;
        // 手動の値より閉じた状態を優先し、開いている間は手動の値(半目など)を保つ
        this.vrm.expressionManager.setValue("blink", Math.max(this._blinkUser, blinkWeightAt(t + this._blinkPhase, this.blink.interval)));
    }

    // 口形を直接設定する(リップシンク)。values: { aa: 0..1, ... }
    setMouth(values) {
        const m = this.vrm.expressionManager;
        if (!m) return;
        for (const v of MOUTH_VISEMES) if (m.getExpression(v)) m.setValue(v, values?.[v] ?? 0);
    }

    // ---- 状態 ----
    getState() {
        return {
            ...super.getState(), pose: this.getPose(), expressions: this.getExpressions(),
        };
    }

    // ---- 子トラック(eyes / blink / lip)----
    // eyes: 目のボーン(bones に入れるとタイムラインで球面補間される)と視線の先
    getChannel(ch) {
        if (ch === "eyes") {
            const bones = {};
            for (const n of EYE_BONES) { const b = this.bone(n); if (b) bones[n] = b.node.quaternion.toArray(); }
            return { bones, lookAt: this.lookAtTarget };
        }
        if (ch === "blink") return { blink: { ...this.blink } };
        if (ch === "lip") return { lip: { enabled: !!this.lip.enabled, gain: this.lip.gain ?? 1.5 } };
        return null;
    }

    setChannel(ch, s) {
        if (!s) return;
        if (ch === "eyes") {
            for (const n of EYE_BONES) { const q = s.bones?.[n]; if (q) this.bone(n)?.node.quaternion.fromArray(q); }
            if (s.lookAt !== undefined) this.lookAtTarget = s.lookAt;
        } else if (ch === "blink") this.setBlink(s.blink);
        else if (ch === "lip" && s.lip) {
            this.lip = { ...this.lip, ...s.lip };
            if (!this.lip.enabled) this.setMouth(null);
        }
    }

    setState(s) {
        if (!s) return;
        super.setState(s);
        // 旧形式のキー・保存データ(本体に視線・まばたきが入っていた)
        if (s.lookAtCamera !== undefined) this.lookAtTarget = s.lookAtCamera ? "camera" : "";
        if (s.lookAtTarget !== undefined) this.lookAtTarget = s.lookAtTarget;
        // 先に ON/OFF を切り替えてから表情を入れる("blink" の手動の値の行き先が変わるため)
        if (s.blink) this.setBlink(s.blink);
        if (s.pose) this.setPose(s.pose);
        if (s.expressions) this.setExpressions(s.expressions);
    }

    serialize() {
        return { ...super.serialize(), springBone: this.springBone, lookAtTarget: this.lookAtTarget, blink: { ...this.blink }, lip: { ...this.lip } };
    }

    pickTargets() { return [this.vrm.scene]; }

    // VRMA を読み込み、一定間隔でサンプリングしたポーズ列を返す([{time, pose}])
    async sampleVrma(url, fps) {
        const l = new GLTFLoader();
        l.register(p => new VRMAnimationLoaderPlugin(p));
        const gltf = await l.loadAsync(url);
        const anim = gltf.userData.vrmAnimations?.[0];
        if (!anim) throw new Error("VRMA animation not found");
        if (this.vrm.lookAt && !this.vrm.scene.children.some(c => c instanceof VRMLookAtQuaternionProxy)) {
            const proxy = new VRMLookAtQuaternionProxy(this.vrm.lookAt);
            proxy.name = "VRMLookAtQuaternionProxy";
            this.vrm.scene.add(proxy);
        }
        return this._sampleClip(createVRMAnimationClip(anim, this.vrm), fps);
    }

    // 読み込んだ FBX(lib/fbx_retarget.js の loadFbx)のテイクを、VRMA と同じ形のポーズ列にする
    sampleFbx(asset, take, fps, opts) {
        return this._sampleClip(fbxToClip(asset, take, this.vrm, opts).clip, fps);
    }

    // 正規化ボーンを動かすクリップを fps 間隔で再生してポーズ列にする(今のポーズは元に戻す)
    _sampleClip(clip, fps) {
        const mixer = new THREE.AnimationMixer(this.vrm.scene);
        const action = mixer.clipAction(clip);
        action.play();
        const saved = this.getPose();
        const out = [];
        const n = Math.max(1, Math.round(clip.duration * fps));
        for (let i = 0; i <= n; i++) {
            const t = Math.min(clip.duration, i / fps);
            mixer.setTime(t);
            out.push({ time: t, pose: this.getPose() });
        }
        mixer.stopAllAction();
        mixer.uncacheRoot(this.vrm.scene);
        this.setPose(saved);
        return { duration: clip.duration, samples: out };
    }

    dispose() {
        this.handles.removeFromParent();
        this.root.removeFromParent();
        VRMUtils.deepDispose(this.vrm.scene);
    }
}

// ================================================================ Prop

export const PRIMITIVES = ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"];

function primitiveGeometry(shape) {
    switch (shape) {
        case "sphere": return new THREE.SphereGeometry(0.25, 32, 16);
        case "cylinder": return new THREE.CylinderGeometry(0.2, 0.2, 0.5, 32);
        case "cone": return new THREE.ConeGeometry(0.25, 0.5, 32);
        case "torus": return new THREE.TorusGeometry(0.22, 0.07, 16, 48);
        case "plane": return new THREE.PlaneGeometry(1, 1);
        case "capsule": return new THREE.CapsuleGeometry(0.15, 0.4, 8, 16);
        default: return new THREE.BoxGeometry(0.4, 0.4, 0.4);
    }
}

export class Prop extends SceneObject {
    // src: { kind: "primitive", shape } / { kind: "gltf", url } / { kind: "image", url }
    static async load(opts) {
        const prop = new Prop(opts);
        await prop._build();
        return prop;
    }

    constructor(opts) {
        super("prop", opts);
        this.color = opts.color ?? "#d0d4e0";
        this.opacity = opts.opacity ?? 1;
        this.castShadow = opts.castShadow ?? true;
        this.content = null;
    }

    async _build() {
        const src = this.src;
        if (src.kind === "primitive") {
            const mat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(primitiveGeometry(src.shape), mat);
            // 床に置いたとき底面が y=0 に来るよう持ち上げる(plane は立てて置く)
            const box = new THREE.Box3().setFromObject(mesh);
            if (src.shape !== "plane") mesh.position.y = -box.min.y;
            else mesh.position.y = 0.5;
            this.content = mesh;
            this._tintable = [mat];
        } else if (src.kind === "image") {
            const tex = await new THREE.TextureLoader().loadAsync(src.url);
            tex.colorSpace = THREE.SRGBColorSpace;
            const a = tex.image.width / tex.image.height;
            const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, alphaTest: 0.01 });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(a >= 1 ? 1 : a, a >= 1 ? 1 / a : 1), mat);
            mesh.position.y = (a >= 1 ? 1 / a : 1) / 2;
            this.content = mesh;
            this._tintable = [mat];
        } else {
            const gltf = await new GLTFLoader().loadAsync(src.url);
            this.content = gltf.scene;
            this._tintable = [];
        }
        this.content.traverse(o => { if (o.isMesh) { o.castShadow = this.castShadow; o.receiveShadow = true; } });
        this.root.add(this.content);
        this.applyMaterial();
    }

    applyMaterial() {
        for (const m of this._tintable ?? []) {
            if (this.src.kind === "primitive") m.color.set(this.color);
            m.opacity = this.opacity;
            m.transparent = this.opacity < 1 || this.src.kind === "image";
            m.needsUpdate = true;
        }
        this.content?.traverse(o => { if (o.isMesh) o.castShadow = this.castShadow; });
    }

    getState() {
        return { ...super.getState(), material: { color: this.color, opacity: this.opacity } };
    }

    setState(s) {
        if (!s) return;
        super.setState(s);
        if (s.material) {
            for (const k of ["color", "opacity"]) if (s.material[k] !== undefined) this[k] = s.material[k];
            this.applyMaterial();
        }
    }

    serialize() {
        return { ...super.serialize(), color: this.color, opacity: this.opacity, castShadow: this.castShadow };
    }
}

// ================================================================ Light

export const LIGHT_KINDS = ["point", "spot", "directional"];

const LIGHT_DEFAULTS = {
    point: { intensity: 3, distance: 6 },
    spot: { intensity: 8, distance: 10 },
    directional: { intensity: 1.5, distance: 0 },
};

// root の +Z 方向を照らす(スポット・平行光)。Object3D.lookAt で対象へ向けられる
export class Light extends SceneObject {
    static async load(opts) {
        const l = new Light(opts);
        l._build();
        return l;
    }

    constructor(opts) {
        super("light", opts);
        const kind = LIGHT_KINDS.includes(this.src.kind) ? this.src.kind : "point";
        this.src = { kind };
        const d = LIGHT_DEFAULTS[kind];
        this.color = opts.color ?? "#ffffff";
        this.intensity = opts.intensity ?? d.intensity;
        this.distance = opts.distance ?? d.distance;
        this.angle = opts.angle ?? 30;       // スポットの広がり(度)
        this.penumbra = opts.penumbra ?? 0.3;
        this.castShadow = opts.castShadow ?? false;
    }

    _build() {
        const kind = this.src.kind;
        const l = kind === "spot" ? new THREE.SpotLight() : kind === "directional" ? new THREE.DirectionalLight() : new THREE.PointLight();
        l.decay = 2;
        l.shadow.mapSize.set(1024, 1024);
        l.shadow.bias = -0.0004;
        l.shadow.normalBias = 0.02;
        if (kind === "directional") {
            const sc = l.shadow.camera;
            sc.left = -4; sc.right = 4; sc.top = 4; sc.bottom = -4; sc.near = 0.1; sc.far = 40;
        }
        if (l.target) {
            l.target.position.set(0, 0, 1);
            this.root.add(l.target);
        }
        this.light = l;
        this.root.add(l);

        // 表示用(書き出しには写らない)。電球の球は選択用の当たり判定も兼ねる
        this.bulbMat = new THREE.MeshBasicMaterial({ color: this.color });
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 8), this.bulbMat);
        this.lineMat = new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.7 });
        this.guide = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
        for (const o of [bulb, this.guide]) { o.layers.set(HELPER_LAYER); o.castShadow = false; o.receiveShadow = false; }
        this.root.add(bulb, this.guide);
        this.applyLight();
    }

    // 向き・広がりの目安線(スポット = 円錐、平行光 = 矢印、点光源 = 十字)
    _updateGuide() {
        const pts = [];
        const kind = this.src.kind;
        if (kind === "spot") {
            const len = Math.min(this.distance || 2, 2), r = Math.tan((this.angle * Math.PI) / 180) * len;
            const n = 24;
            for (let i = 0; i < n; i++) {
                const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
                pts.push(Math.cos(a0) * r, Math.sin(a0) * r, len, Math.cos(a1) * r, Math.sin(a1) * r, len);
                if (i % 6 === 0) pts.push(0, 0, 0, Math.cos(a0) * r, Math.sin(a0) * r, len);
            }
        } else if (kind === "directional") {
            pts.push(0, 0, 0, 0, 0, 1, 0, 0, 1, 0.06, 0, 0.88, 0, 0, 1, -0.06, 0, 0.88, 0, 0, 1, 0, 0.06, 0.88, 0, 0, 1, 0, -0.06, 0.88);
        } else {
            const s = 0.14;
            pts.push(-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s);
        }
        this.guide.geometry.dispose();
        this.guide.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    }

    applyLight() {
        const l = this.light;
        l.color.set(this.color);
        l.intensity = this.intensity;
        if (l.isSpotLight || l.isPointLight) l.distance = this.distance;
        if (l.isSpotLight) { l.angle = (this.angle * Math.PI) / 180; l.penumbra = this.penumbra; }
        l.castShadow = !!this.castShadow;
        this.bulbMat.color.set(this.color);
        this.lineMat.color.set(this.color);
        this._updateGuide();
    }

    getState() {
        return { ...super.getState(), light: { color: this.color, intensity: this.intensity, distance: this.distance, angle: this.angle, penumbra: this.penumbra } };
    }

    setState(s) {
        if (!s) return;
        super.setState(s);
        if (s.light) {
            for (const k of ["color", "intensity", "distance", "angle", "penumbra"]) if (s.light[k] !== undefined) this[k] = s.light[k];
            this.applyLight();
        }
    }

    serialize() {
        return { ...super.serialize(), castShadow: this.castShadow };
    }

    pickTargets() { return [this.root]; }

    dispose() {
        this.light.dispose();
        super.dispose();
    }
}

export async function createObject(data) {
    const obj = data.type === "actor" ? await Actor.load(data) : data.type === "light" ? await Light.load(data) : await Prop.load(data);
    obj.setState(data);
    if (data.locked) obj.locked = true;
    if (obj.type === "actor") {
        if (data.springBone !== undefined) obj.springBone = data.springBone;
        if (data.lip) obj.lip = { ...obj.lip, ...data.lip };
    }
    return obj;
}
