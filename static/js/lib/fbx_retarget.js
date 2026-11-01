// fbx_retarget.js — FBX のモーション(Mixamo / MotionBuilder など)を VRM の正規化ボーン用のクリップにする
//
// 計算は three-vrm 公式サンプル loadMixamoAnimation.js(MIT)と同じ:
//   各ボーンの回転を「親のレストのワールド回転 × アニメーションの回転 × 自分のレストのワールド回転の逆」で
//   ワールド基準の差分にしてから正規化ボーン(レストが全て単位回転)に当てる。腰の位置は腰の高さの比で縮める。
// レストは FBX を読み込んだ直後の姿勢(Mixamo なら T ポーズ)を使う。
// ボーン名は名前空間・接頭辞(mixamorig: / Character1: など)を外して、末尾が一致する一番長い名前で引く。

import * as THREE from "../../vendor/three.module.js";
import { FBXLoader } from "../../vendor/FBXLoader.js";

// Mixamo / MotionBuilder(HumanIK)の名前 → VRM Humanoid
const RIG_MAP = {
    Hips: "hips", Spine: "spine", Spine1: "chest", Spine2: "upperChest", Neck: "neck", Head: "head",
    LeftShoulder: "leftShoulder", LeftArm: "leftUpperArm", LeftForeArm: "leftLowerArm", LeftHand: "leftHand",
    RightShoulder: "rightShoulder", RightArm: "rightUpperArm", RightForeArm: "rightLowerArm", RightHand: "rightHand",
    LeftUpLeg: "leftUpperLeg", LeftLeg: "leftLowerLeg", LeftFoot: "leftFoot", LeftToeBase: "leftToes",
    RightUpLeg: "rightUpperLeg", RightLeg: "rightLowerLeg", RightFoot: "rightFoot", RightToeBase: "rightToes",
};
for (const side of ["Left", "Right"]) {
    const s = side.toLowerCase();
    RIG_MAP[`${side}HandThumb1`] = `${s}ThumbMetacarpal`;
    RIG_MAP[`${side}HandThumb2`] = `${s}ThumbProximal`;
    RIG_MAP[`${side}HandThumb3`] = `${s}ThumbDistal`;
    for (const [fbx, vrm] of [["Index", "Index"], ["Middle", "Middle"], ["Ring", "Ring"], ["Pinky", "Little"]]) {
        RIG_MAP[`${side}Hand${fbx}1`] = `${s}${vrm}Proximal`;
        RIG_MAP[`${side}Hand${fbx}2`] = `${s}${vrm}Intermediate`;
        RIG_MAP[`${side}Hand${fbx}3`] = `${s}${vrm}Distal`;
    }
}
const KEYS = Object.keys(RIG_MAP).sort((a, b) => b.length - a.length).map(k => [k.toLowerCase(), RIG_MAP[k]]);

// FBX のノード名 → VRM のボーン名(VRM の名前そのもの(leftUpperArm など)も受け付ける)
export function vrmBoneFor(name, vrmBones) {
    const n = name.toLowerCase();
    const direct = vrmBones.find(b => b.toLowerCase() === n || n.endsWith(b.toLowerCase()) && /[^a-z]/.test(n[n.length - b.length - 1] ?? "_"));
    if (direct) return direct;
    for (const [k, v] of KEYS) {
        if (!n.endsWith(k)) continue;
        // "LeftHand" が "...LeftHandIndex1" に誤って当たらないよう、直前が英大文字小文字の続きでないことを確かめる
        const prev = name[name.length - k.length - 1];
        if (prev === undefined || !/[a-z]/.test(prev) || /mixamorig\d*$/i.test(name.slice(0, name.length - k.length))) return v;
    }
    return null;
}

// FBX を読む。takes: [{ name, duration }](アニメーションの入ったテイク)
export async function loadFbx(url) {
    const asset = await new FBXLoader().loadAsync(url);
    asset.updateWorldMatrix(true, true);
    const takes = asset.animations.map((a, i) => ({ index: i, name: a.name || `Take ${i + 1}`, duration: a.duration })).filter(t => asset.animations[t.index].tracks.length);
    if (!takes.length) throw new Error("FBX にアニメーションがありません");
    return { asset, takes };
}

// 読んだ FBX のテイクを、vrm の正規化ボーンを動かすクリップにする。{ clip, mapped: [VRM ボーン名], unmapped: [FBX の名前] }
// rootMotion: false なら腰の水平移動を消して、その場で動かす(最初のフレームの位置に固定)
export function fbxToClip(asset, take, vrm, { rootMotion = true } = {}) {
    const src = asset.animations[take];
    if (!src?.tracks.length) throw new Error("FBX にアニメーションがありません");

    const humanoid = vrm.humanoid;
    const vrmBones = Object.keys(humanoid.humanBones);
    const nodes = new Map();   // FBX のノード名 → VRM のボーン名
    asset.traverse(o => {
        const b = vrmBoneFor(o.name, vrmBones);
        if (b && humanoid.getNormalizedBoneNode(b) && ![...nodes.values()].includes(b)) nodes.set(o.name, b);
    });
    const hipsNode = [...nodes].find(([, b]) => b === "hips")?.[0];
    if (!hipsNode) throw new Error("FBX に腰(Hips)のボーンが見つかりません");

    // 腰の高さの比で位置を合わせる
    const v = new THREE.Vector3();
    const motionHips = asset.getObjectByName(hipsNode);
    // 腰の位置トラックと同じく、親のワールド回転で向きを直した高さ(Z-up のリグでも縦になる)
    const motionHipsHeight = Math.abs(motionHips.position.clone().applyQuaternion(motionHips.parent.getWorldQuaternion(new THREE.Quaternion())).y) || 1;
    const vrmHipsHeight = Math.abs(humanoid.getNormalizedBoneNode("hips").getWorldPosition(v).y - vrm.scene.getWorldPosition(new THREE.Vector3()).y);
    const scale = vrmHipsHeight / motionHipsHeight;
    const isVrm0 = vrm.meta?.metaVersion === "0";

    const restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion(), q = new THREE.Quaternion();
    const tracks = [];
    const unmapped = new Set();
    for (const track of src.tracks) {
        const dot = track.name.lastIndexOf(".");
        const nodeName = track.name.slice(0, dot), prop = track.name.slice(dot + 1);
        const bone = nodes.get(nodeName);
        if (!bone) { unmapped.add(nodeName); continue; }
        const target = humanoid.getNormalizedBoneNode(bone).name;
        const node = asset.getObjectByName(nodeName);
        if (track instanceof THREE.QuaternionKeyframeTrack) {
            node.getWorldQuaternion(restInv).invert();
            node.parent.getWorldQuaternion(parentRest);
            const values = new Float32Array(track.values.length);
            for (let i = 0; i < values.length; i += 4) {
                q.fromArray(track.values, i).premultiply(parentRest).multiply(restInv);
                // VRM 0.x は向きが逆(-Z 向き)なので x と z を反転
                values[i] = isVrm0 ? -q.x : q.x; values[i + 1] = q.y; values[i + 2] = isVrm0 ? -q.z : q.z; values[i + 3] = q.w;
            }
            tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, track.times, values));
        } else if (prop === "position" && bone === "hips") {
            // 位置は腰だけ(親のワールド回転で向きを直してから縮める)
            node.parent.getWorldQuaternion(parentRest);
            const values = new Float32Array(track.values.length);
            for (let i = 0; i < values.length; i += 3) {
                v.fromArray(track.values, i).applyQuaternion(parentRest).multiplyScalar(scale);
                values[i] = isVrm0 ? -v.x : v.x; values[i + 1] = v.y; values[i + 2] = isVrm0 ? -v.z : v.z;
            }
            if (!rootMotion) for (let i = 3; i < values.length; i += 3) { values[i] = values[0]; values[i + 2] = values[2]; }
            tracks.push(new THREE.VectorKeyframeTrack(`${target}.position`, track.times, values));
        }
    }
    return {
        clip: new THREE.AnimationClip("fbx", src.duration, tracks),
        mapped: [...new Set(nodes.values())],
        unmapped: [...unmapped],
    };
}
