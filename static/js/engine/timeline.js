// timeline.js — キーフレームのデータと補間
//
// tracks: { [trackId]: [{ frame, state, ease }] }(frame 昇順)
//   trackId はオブジェクト id、カメラ用の "camera"、背景・ライト用の "scene"。
//   state はオブジェクトの getState() / カメラの getCameraState() のスナップショット。
// ease は「そのキーから次のキーへ」の補間: "linear" | "ease" | "step"

import * as THREE from "../../vendor/three.module.js";

export const CAMERA_TRACK = "camera";
export const SCENE_TRACK = "scene";
export const WIND_TRACK = "wind";
export const EASES = ["linear", "ease", "step"];

// 人物の子トラック(タイムラインでは人物の行の下に折りたたみで並ぶ)。
// 本体のトラック(ポーズ・表情・位置)とは別にキーを持ち、本体より後に当てる。trackId は "<人物 id>#<ch>"
export const CHANNELS = ["eyes", "blink", "lip"];
export const channelTrack = (id, ch) => `${id}#${ch}`;
export function parseTrack(tid) {
    const i = tid.lastIndexOf("#");
    return i > 0 && CHANNELS.includes(tid.slice(i + 1)) ? { owner: tid.slice(0, i), ch: tid.slice(i + 1) } : { owner: tid, ch: null };
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _ca = new THREE.Color();
const _cb = new THREE.Color();
const HEX = /^#[0-9a-f]{6}$/i;

function isQuatPath(path) {
    const last = path[path.length - 1];
    return last === "q" || path[path.length - 2] === "bones";
}

function lerpValue(a, b, t, path) {
    if (a === undefined) return typeof b === "number" ? b * t : b;
    if (b === undefined) return typeof a === "number" ? a * (1 - t) : a;
    if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length === 4 && b.length === 4 && isQuatPath(path)) {
            _qa.fromArray(a); _qb.fromArray(b);
            return _qa.slerp(_qb, t).toArray();
        }
        return a.map((v, i) => (typeof v === "number" && typeof b[i] === "number" ? v + (b[i] - v) * t : v));
    }
    if (typeof a === "string" && typeof b === "string" && HEX.test(a) && HEX.test(b)) {
        return "#" + _ca.set(a).lerp(_cb.set(b), t).getHexString();
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        const out = {};
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = lerpValue(a[k], b[k], t, [...path, k]);
        return out;
    }
    return a; // 真偽値・文字列(色以外)は前のキーの値を保つ
}

// ---- タイムストレッチ(3D Pose Editor の keyframe_stretch.js と同じ計算) ----
// range: { start, end, newLength, shiftAfter }
//   start〜end のキーは start を起点に newLength / (end - start) 倍の間隔にする。
//   end より後ろは shiftAfter なら伸縮で増減した長さだけずらし、そうでなければ動かさない。start より前は動かさない
export function stretchFrame(f, { start, end, newLength, shiftAfter = true }) {
    if (f < start) return f;
    if (f <= end) return start + (f - start) * (newLength / (end - start));
    return shiftAfter ? f + (newLength - (end - start)) : f;
}

// 1 トラック分のキー(フレーム番号)の移動先。縮めて同じフレームに丸められたキーは、
// 伸縮後の位置(小数)がそのフレームに一番近いものだけを残す(動かないキーは誤差 0 なので必ず残る)。
// 戻り値: { moves: Map<元のフレーム, 新しいフレーム>, dropped: [元のフレーム...] }
export function planTrackStretch(frames, range) {
    const best = new Map(); // 新しいフレーム → { from, err }
    for (const from of frames) {
        const x = Math.max(0, stretchFrame(from, range));
        const to = Math.round(x);
        const err = Math.abs(x - to);
        const cur = best.get(to);
        if (!cur || err < cur.err - 1e-9) best.set(to, { from, err });
    }
    const moves = new Map();
    for (const [to, { from }] of best) moves.set(from, to);
    return { moves, dropped: frames.filter(f => !moves.has(f)) };
}

function easeT(t, ease) {
    if (ease === "step") return 0;
    if (ease === "ease") return t * t * (3 - 2 * t);
    return t;
}

export class Timeline extends EventTarget {
    constructor() {
        super();
        this.fps = 24;
        this.frames = 120;     // 全長(フレーム数)
        this.range = null;      // 書き出し・ループ範囲 [start, end](null = 全体)
        this.tracks = {};
        this.current = 0;       // 現在フレーム(再生中は小数)
    }

    get duration() { return this.frames / this.fps; }

    keys(trackId) { return this.tracks[trackId] ?? []; }

    hasKeys(trackId) { return (this.tracks[trackId]?.length ?? 0) > 0; }

    setKey(trackId, frame, state, ease) {
        frame = Math.round(frame);
        const list = (this.tracks[trackId] ??= []);
        const i = list.findIndex(k => k.frame === frame);
        const key = { frame, state: structuredClone(state), ease: ease ?? (i >= 0 ? list[i].ease : "linear") };
        if (i >= 0) list[i] = key; else list.push(key);
        list.sort((a, b) => a.frame - b.frame);
        this._changed();
        return key;
    }

    removeKey(trackId, frame) {
        const list = this.tracks[trackId];
        if (!list) return;
        const i = list.findIndex(k => k.frame === frame);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) delete this.tracks[trackId];
        this._changed();
    }

    removeTrack(trackId) {
        delete this.tracks[trackId];
        this._changed();
    }

    // キーをまとめて移動(selection: [{trackId, frame}])。衝突したら上書き
    moveKeys(selection, delta) {
        if (!delta) return selection;
        const moved = [];
        const byTrack = {};
        for (const s of selection) (byTrack[s.trackId] ??= []).push(s.frame);
        for (const [tid, frames] of Object.entries(byTrack)) {
            const list = this.tracks[tid];
            if (!list) continue;
            const taken = list.filter(k => frames.includes(k.frame));
            const rest = list.filter(k => !frames.includes(k.frame));
            for (const k of taken) {
                k.frame = Math.max(0, k.frame + delta);
                const dup = rest.findIndex(r => r.frame === k.frame);
                if (dup >= 0) rest.splice(dup, 1);
                moved.push({ trackId: tid, frame: k.frame });
            }
            this.tracks[tid] = [...rest, ...taken].sort((a, b) => a.frame - b.frame);
        }
        this._changed();
        return moved;
    }

    // タイムストレッチ: trackIds のキーの間隔を range のとおり伸縮する。全体の長さ・書き出し範囲も合わせる。
    // 戻り値: 間引いたキーの数
    stretch(trackIds, range) {
        let dropped = 0;
        for (const id of trackIds) {
            const list = this.tracks[id];
            if (!list?.length) continue;
            const plan = planTrackStretch(list.map(k => k.frame), range);
            dropped += plan.dropped.length;
            this.tracks[id] = list.filter(k => plan.moves.has(k.frame))
                .map(k => ({ ...k, frame: plan.moves.get(k.frame) }))
                .sort((a, b) => a.frame - b.frame);
        }
        if (range.shiftAfter && this.frames >= range.end) this.frames = Math.max(1, Math.round(stretchFrame(this.frames, range)));
        if (this.range) {
            const [s, e] = this.range.map(f => Math.round(stretchFrame(f, range)));
            this.range = [s, Math.max(s + 1, e)];
        }
        this._changed();
        return dropped;
    }

    setEase(trackId, frame, ease) {
        const k = this.keys(trackId).find(x => x.frame === frame);
        if (k) { k.ease = ease; this._changed(); }
    }

    evaluate(trackId, frame) {
        const list = this.tracks[trackId];
        if (!list?.length) return null;
        if (frame <= list[0].frame) return list[0].state;
        const last = list[list.length - 1];
        if (frame >= last.frame) return last.state;
        let i = 0;
        while (i < list.length - 1 && list[i + 1].frame <= frame) i++;
        const a = list[i], b = list[i + 1];
        const t = easeT((frame - a.frame) / (b.frame - a.frame), a.ease);
        if (t === 0) return a.state;
        return lerpValue(a.state, b.state, t, []);
    }

    nextKeyFrame(from, dir, trackIds) {
        const frames = new Set();
        for (const id of trackIds ?? Object.keys(this.tracks)) for (const k of this.keys(id)) frames.add(k.frame);
        const sorted = [...frames].sort((a, b) => a - b);
        if (dir > 0) return sorted.find(f => f > from) ?? null;
        return [...sorted].reverse().find(f => f < from) ?? null;
    }

    playRange() {
        const [s, e] = this.range ?? [0, this.frames];
        return [Math.max(0, s), Math.min(this.frames, Math.max(s + 1, e))];
    }

    serialize() {
        return { fps: this.fps, frames: this.frames, range: this.range, tracks: structuredClone(this.tracks) };
    }

    load(d) {
        this.fps = d?.fps ?? 24;
        this.frames = d?.frames ?? 120;
        this.range = d?.range ?? null;
        this.tracks = structuredClone(d?.tracks ?? {});
        this.current = Math.min(this.current, this.frames);
        this._changed();
    }

    _changed() { this.dispatchEvent(new CustomEvent("change")); }
}
