// timeline-ui.js — 下パネル(再生コントロール・ルーラー・トラックとキーフレーム・音声バー)
//
// 操作:
//   ルーラー/空き領域のクリック・ドラッグ … 再生位置の移動
//   キーのクリック(Shift で追加選択)/ドラッグ … 選択・移動
//   🗑 削除モード中 … キーのクリック/なぞったキーを消す(始めた行だけ。Shift を押している間はカーソルの行)
//   トラックのダブルクリック … その位置にキーを打つ
//   音声バーのドラッグ … 音声の開始位置を変更(0 秒より前には置けない)
//   ✂ … 波形を見ながら音声を分割(audio-split.js) / B … 再生位置ですぐ分割
//   ホイール … 横スクロール / Ctrl+ホイール … ズーム

import { t } from "../i18n.js";
import { ICON } from "./outliner.js";
import { el, clear, toast, fmtTime } from "../util.js";
import { pickAsset } from "./assets.js";
import { SCENE_TRACK, WIND_TRACK, CHANNELS, channelTrack, parseTrack, EASES } from "../engine/timeline.js";
import { CUT_TRACK } from "../engine/cameras.js";
import { clipLength } from "../engine/studio.js";
import { openAudioSplit } from "./audio-split.js";
import { openTimeStretch } from "./time-stretch.js";

const ROW_H = 24;
const RULER_H = 24;
const KEY_R = 5;
const FPS_CHOICES = [12, 15, 24, 25, 30, 60];
const CH_ICON = { eyes: "👁", blink: "😑", lip: "👄" };
const CH_COLOR = { eyes: "#4ecdc4", blink: "#a29bfe", lip: "#ff7eb6" };
const WIND_COLOR = "#7fd8ff";
// 表示の絞り込み: all / actors(人物と子トラック)/ env(背景・ライト、風、ライト)/ audio
const FILTERS = ["all", "actors", "env", "audio"];
const FILTER_KEY = "vps:tlFilter", EXPAND_KEY = "vps:tlExpanded";

function loadPref(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function savePref(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

export function buildTimeline(root, studio) {
    const tl = studio.timeline;
    let pxPerFrame = 6;
    let scrollX = 0;            // 左端のフレーム
    let selected = [];          // [{trackId, frame}]
    let clipboard = null;       // { base, items: [{trackId, dframe, key}] }
    let selClip = null;         // 選んでいる音声トラックの id(Delete で外す)
    let deleteMode = false;
    let filter = loadPref(FILTER_KEY, "all");
    if (!FILTERS.includes(filter)) filter = "all";
    const expanded = new Set(loadPref(EXPAND_KEY, []));   // 子トラックを開いている人物の id

    // ---------------------------------------------------------------- toolbar
    const frameInput = el("input.vps-num.frame", { type: "number", min: 0, step: 1, onchange: () => studio.seek(+frameInput.value) });
    const timeLabel = el("span.vps-time");
    const playBtn = el("button.vps-btn.icon", { title: t("play"), onclick: () => studio.play() }, "▶");
    const autoKeyBtn = el("button.vps-btn.small.toggle", { title: t("autoKey"), onclick: () => { studio.autoKey = !studio.autoKey; syncToolbar(); } }, `● ${t("autoKey")}`);
    const delModeBtn = el("button.vps-btn.small.toggle.vps-del-mode", { title: t("deleteModeTip"), onclick: () => setDeleteMode(!deleteMode) }, `🗑 ${t("deleteMode")}`);
    const loopBtn = el("button.vps-btn.small.toggle", { title: t("loop"), onclick: () => { studio.loop = !studio.loop; syncToolbar(); } }, "🔁");
    const fpsSel = el("select.vps-select.small", { onchange: () => studio.setFps(+fpsSel.value) }, FPS_CHOICES.map(f => el("option", { value: f }, `${f} fps`)));
    const lenInput = el("input.vps-num", { type: "number", min: 1, step: 1, title: t("length"), onchange: () => studio.setTimelineLength(+lenInput.value) });
    const lenSec = el("span.vps-time");
    const easeSel = el("select.vps-select.small", {
        title: t("ease"),
        onchange: () => { for (const s of selected) tl.setEase(s.trackId, s.frame, easeSel.value); studio.commitEdit({ key: false }); },
    }, EASES.map(e => el("option", { value: e }, t(`ease${e[0].toUpperCase()}${e.slice(1)}`))));
    const audioBtn = el("button.vps-btn.small", { title: t("addAudioTrack"), onclick: () => chooseAudio() }, `🎵 ${t("audio")} ＋`);

    const jump = dir => {
        const id = studio.selection?.id;
        const ids = id ? [id, ...CHANNELS.map(ch => channelTrack(id, ch)), ...(id === SCENE_TRACK ? [WIND_TRACK] : [])] : undefined;
        const f = tl.nextKeyFrame(Math.round(tl.current), dir, ids);
        if (f !== null) studio.seek(f);
    };

    const toolbar = el("div.vps-tl-toolbar",
        el("button.vps-btn.icon", { title: "Home", onclick: () => studio.seek(tl.playRange()[0]) }, "⏮"),
        el("button.vps-btn.icon", { title: "◀◆", onclick: () => jump(-1) }, "◀◆"),
        playBtn,
        el("button.vps-btn.icon", { title: "◆▶", onclick: () => jump(1) }, "◆▶"),
        el("button.vps-btn.icon", { title: "End", onclick: () => studio.seek(tl.playRange()[1]) }, "⏭"),
        frameInput, timeLabel,
        el("span.vps-sep"),
        el("button.vps-btn.small.primary", { title: t("key"), onclick: () => studio.keySelected() }, `◆ ${t("key").replace(/ \(K\)/, "")}`),
        el("button.vps-btn.small", { onclick: () => studio.keyAll() }, t("keyAll")),
        autoKeyBtn,
        el("span.vps-sep"),
        el("label.vps-inline", t("ease"), easeSel),
        el("button.vps-btn.small", { title: "Delete", onclick: () => deleteSelected() }, `🗑 ${t("deleteKeys")}`),
        delModeBtn,
        el("button.vps-btn.small", { title: "Ctrl+C", onclick: () => copyKeys() }, t("copyKeys")),
        el("button.vps-btn.small", { title: "Ctrl+V", onclick: () => pasteKeys() }, t("pasteKeys")),
        el("span.vps-sep"),
        fpsSel,
        el("label.vps-inline", t("length"), lenInput, lenSec),
        el("button.vps-btn.small", { title: t("setIn"), onclick: () => setRange(0) }, "[ IN"),
        el("button.vps-btn.small", { title: t("setOut"), onclick: () => setRange(1) }, "OUT ]"),
        el("button.vps-btn.small", { title: t("clearRange"), onclick: () => { tl.range = null; tl._changed(); studio.commitEdit({ key: false }); } }, "[ ]✕"),
        el("button.vps-btn.small", { title: t("stretchTip"), onclick: () => openTimeStretch(studio) }, `⏱ ${t("stretch")}`),
        loopBtn,
        el("span.vps-sep"),
        audioBtn,
        el("button.vps-btn.small", { title: t("splitAudioTip"), onclick: () => openSplit() }, `✂ ${t("splitAudio")}`),
    );

    // ---------------------------------------------------------------- body
    const labels = el("div.vps-tl-labels");
    const ruler = el("canvas.vps-tl-ruler");
    const tracks = el("canvas.vps-tl-tracks");
    const filterSel = el("select.vps-select.small.vps-tl-filter", {
        title: t("tlFilter"),
        onchange: () => { filter = filterSel.value; savePref(FILTER_KEY, filter); draw(); },
    }, FILTERS.map(f => el("option", { value: f, selected: f === filter }, t(`filter${f[0].toUpperCase()}${f.slice(1)}`))));
    const rulerWrap = el("div.vps-tl-ruler-wrap", el("div.vps-tl-corner", filterSel), ruler);
    const scroll = el("div.vps-tl-scroll", labels, el("div.vps-tl-canvas-wrap", tracks));
    root.append(toolbar, rulerWrap, scroll);

    // 行の一覧。owner = ラベルのクリックで選ぶもの(子トラックは親の人物)
    function rows() {
        const r = [];
        const all = filter === "all";
        if (all || filter === "env") {
            r.push({ id: SCENE_TRACK, owner: SCENE_TRACK, label: `🌄 ${t("scene")}` });
            r.push({ id: WIND_TRACK, owner: WIND_TRACK, label: `🌬 ${t("wind")}`, color: WIND_COLOR });
        }
        if (all) {
            r.push({ id: CUT_TRACK, owner: CUT_TRACK, label: `🎬 ${t("cut")}` });
            for (const c of studio.cams.list()) r.push({ id: c.id, owner: c.id, label: `🎥 ${c.name}`, color: c.color });
        }
        for (const o of studio.list()) {
            const kind = o.type === "actor" ? "actors" : o.type === "light" ? "env" : "props";
            if (!all && filter !== kind) continue;
            const open = o.type === "actor" && expanded.has(o.id);
            r.push({ id: o.id, owner: o.id, label: `${ICON[o.type] ?? "📦"} ${o.name}`, expandable: o.type === "actor", open, sig: open ? "o" : "" });
            if (open) {
                for (const ch of CHANNELS) {
                    const cap = ch[0].toUpperCase() + ch.slice(1);
                    r.push({ id: channelTrack(o.id, ch), owner: o.id, sub: true, label: `${CH_ICON[ch]} ${t(`ch${cap}`)}`, color: CH_COLOR[ch] });
                }
            }
        }
        if (all || filter === "audio") {
            // 音声トラックは 1 本ずつ行にする(分割したクリップは同じ行。無いときは追加用の空の行)
            if (!studio.audios.length) r.push({ id: "__audio", label: `🎵 ${t("audio")}` });
            for (const { track, clips, name, muted } of studio.audioTracks()) {
                r.push({ id: `__audio:${track}`, track, clips, label: `🎵 ${name}`, sig: muted ? "m" : "", muted });
            }
        }
        return r;
    }

    function toggleExpand(id) {
        if (!expanded.delete(id)) expanded.add(id);
        savePref(EXPAND_KEY, [...expanded]);
        draw();
    }

    const clipAt = (r, x) => r?.clips?.find(c => x >= xOf(c.offset * tl.fps) - 2 && x <= xOf((c.offset + clipLength(c)) * tl.fps) + 2);

    const xOf = f => (f - scrollX) * pxPerFrame;
    const frameAt = x => x / pxPerFrame + scrollX;

    function sizeCanvas(c, w, h) {
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
            c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
            c.style.width = `${w}px`; c.style.height = `${h}px`;
        }
        const ctx = c.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }

    const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    function draw() {
        const w = tracks.parentElement.clientWidth;
        const rs = rows();
        const h = rs.length * ROW_H;
        const [rs0, re0] = tl.playRange();

        // ルーラー
        let ctx = sizeCanvas(ruler, ruler.parentElement.clientWidth - labels.offsetWidth, RULER_H);
        const rw = ruler.width / (window.devicePixelRatio || 1);
        ctx.fillStyle = css("--vps-bg-2"); ctx.fillRect(0, 0, rw, RULER_H);
        if (tl.range) { ctx.fillStyle = "rgba(74,158,255,0.25)"; ctx.fillRect(xOf(rs0), 0, xOf(re0) - xOf(rs0), RULER_H); }
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(xOf(tl.frames), 0, rw, RULER_H);
        const step = niceStep();
        ctx.strokeStyle = css("--vps-border"); ctx.fillStyle = css("--vps-text-2"); ctx.font = "10px sans-serif"; ctx.textBaseline = "top";
        for (let f = Math.floor(scrollX / step) * step; xOf(f) < rw; f += step) {
            if (f < 0) continue;
            const x = Math.round(xOf(f)) + 0.5;
            ctx.beginPath(); ctx.moveTo(x, RULER_H - 8); ctx.lineTo(x, RULER_H); ctx.stroke();
            ctx.fillText(String(f), x + 2, 3);
        }
        drawPlayhead(ctx, RULER_H, true);

        // トラック
        ctx = sizeCanvas(tracks, w, Math.max(h, scroll.clientHeight - 2));
        const th = Math.max(h, scroll.clientHeight - 2);
        ctx.fillStyle = css("--vps-bg"); ctx.fillRect(0, 0, w, th);
        rs.forEach((r, i) => {
            const y = i * ROW_H;
            const isSel = !!r.owner && studio.selection?.id === r.owner;
            ctx.fillStyle = isSel ? "rgba(74,158,255,0.12)" : i % 2 ? "rgba(255,255,255,0.02)" : "transparent";
            ctx.fillRect(0, y, w, ROW_H);
            ctx.strokeStyle = css("--vps-border"); ctx.beginPath(); ctx.moveTo(0, y + ROW_H - 0.5); ctx.lineTo(w, y + ROW_H - 0.5); ctx.stroke();
            if (r.id.startsWith("__audio")) return r.clips?.forEach(c => drawAudio(ctx, y, c));
            if (r.id === CUT_TRACK) return drawCuts(ctx, y, w);
            // 閉じている人物の行には、子トラックのキーを小さな点で出す
            if (r.expandable && !r.open) {
                for (const ch of CHANNELS) {
                    ctx.fillStyle = CH_COLOR[ch];
                    for (const k of tl.keys(channelTrack(r.id, ch))) {
                        const x = xOf(k.frame);
                        if (x < -3 || x > w + 3) continue;
                        ctx.beginPath(); ctx.arc(x, y + ROW_H - 4, 2, 0, Math.PI * 2); ctx.fill();
                    }
                }
            }
            const keys = tl.keys(r.id);
            // キー間の補間区間
            for (let k = 0; k < keys.length - 1; k++) {
                ctx.fillStyle = keys[k].ease === "step" ? "rgba(255,165,2,0.18)" : "rgba(124,92,252,0.22)";
                ctx.fillRect(xOf(keys[k].frame), y + ROW_H / 2 - 2, xOf(keys[k + 1].frame) - xOf(keys[k].frame), 4);
            }
            for (const k of keys) {
                const x = xOf(k.frame), cy = y + ROW_H / 2;
                if (x < -KEY_R || x > w + KEY_R) continue;
                const sel = selected.some(s => s.trackId === r.id && s.frame === k.frame);
                ctx.fillStyle = sel ? "#ffd24a" : r.color ?? (r.id === SCENE_TRACK ? "#ffa502" : "#7c9cff");
                ctx.beginPath();
                ctx.moveTo(x, cy - KEY_R); ctx.lineTo(x + KEY_R, cy); ctx.lineTo(x, cy + KEY_R); ctx.lineTo(x - KEY_R, cy); ctx.closePath();
                ctx.fill();
                if (k.ease === "step") { ctx.strokeStyle = "#000"; ctx.stroke(); }
            }
        });
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(xOf(tl.frames), 0, w, th);
        if (tl.range) {
            ctx.fillStyle = "rgba(0,0,0,0.18)";
            ctx.fillRect(0, 0, xOf(rs0), th);
            ctx.fillRect(xOf(re0), 0, w, th);
        }
        drawPlayhead(ctx, th, false);

        // ラベル
        if (labels.childElementCount !== rs.length || labels.dataset.sig !== rs.map(r => r.id + r.label + (r.sig ?? "")).join("|")) {
            clear(labels);
            labels.dataset.sig = rs.map(r => r.id + r.label + (r.sig ?? "")).join("|");
            for (const r of rs) {
                labels.append(el(`div.vps-tl-label${r.sub ? ".sub" : ""}`, {
                    style: { height: `${ROW_H}px` },
                    title: r.label,
                    onclick: () => {
                        if (r.clips) { selClip = r.clips[0].id; draw(); }
                        else if (r.id === "__audio") chooseAudio();
                        else studio.select(r.owner);
                    },
                },
                    r.expandable ? el("button.vps-icon-btn.vps-tl-expand", { title: t("expandTracks"), onclick: e => { e.stopPropagation(); toggleExpand(r.id); } }, r.open ? "▾" : "▸") : null,
                    el("span.vps-tl-label-text", r.label),
                    r.clips ? el("button.vps-icon-btn", { title: t("audioMute"), onclick: e => { e.stopPropagation(); studio.setAudioTrackProps(r.track, { muted: !r.muted }); } }, r.muted ? "🔇" : "🔊") : null,
                    r.clips ? el("button.vps-icon-btn", { title: t("audioRemoveTrack"), onclick: e => { e.stopPropagation(); removeTrack(r.track); } }, "✕") : null,
                ));
            }
        }
        labels.querySelectorAll(".vps-tl-label").forEach((n, i) => n.classList.toggle("selected", (!!rs[i]?.owner && rs[i].owner === studio.selection?.id) || !!rs[i]?.clips?.some(c => c.id === selClip)));
    }

    // カット: 次のカットまでをカメラの色の帯で塗り、カメラ名を書く
    function drawCuts(ctx, y, w) {
        const keys = tl.keys(CUT_TRACK);
        ctx.font = "11px sans-serif"; ctx.textBaseline = "middle";
        keys.forEach((k, i) => {
            const cam = studio.cams.get(k.state?.camera);
            const x0 = xOf(k.frame), x1 = i < keys.length - 1 ? xOf(keys[i + 1].frame) : xOf(tl.frames);
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = cam?.color ?? "#888";
            ctx.fillRect(x0, y + 3, Math.max(2, x1 - x0), ROW_H - 6);
            ctx.globalAlpha = 1;
            const sel = selected.some(s => s.trackId === CUT_TRACK && s.frame === k.frame);
            ctx.fillStyle = sel ? "#ffd24a" : cam?.color ?? "#888";
            ctx.fillRect(x0 - 1.5, y + 2, 3, ROW_H - 4);
            ctx.fillStyle = css("--vps-text");
            ctx.save();
            ctx.beginPath(); ctx.rect(x0, y, Math.max(0, x1 - x0), ROW_H); ctx.clip();
            ctx.fillText(cam?.name ?? "?", x0 + 5, y + ROW_H / 2);
            ctx.restore();
        });
    }

    // 音声のバーと波形(口パク用に解析した音量)。選択中は枠を付ける
    function drawAudio(ctx, y, a) {
        if (!a?.duration) return;
        const x0 = xOf((a.offset || 0) * tl.fps), x1 = xOf(((a.offset || 0) + clipLength(a)) * tl.fps);
        ctx.fillStyle = a.muted ? "rgba(140,140,140,0.25)" : "rgba(46,213,115,0.3)";
        ctx.fillRect(x0, y + 3, x1 - x0, ROW_H - 6);
        const env = studio._clips.get(a.id)?.env;
        if (env) {
            const w = tracks.width / (window.devicePixelRatio || 1);
            const mid = y + ROW_H / 2, half = ROW_H / 2 - 4;
            ctx.fillStyle = a.muted ? "rgba(170,170,170,0.5)" : "rgba(46,213,115,0.8)";
            for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
                const sec = frameAt(x) / tl.fps - (a.offset || 0) + (a.trim || 0);
                const v = env.env[Math.floor(sec * env.rate)] ?? 0;
                const hgt = Math.max(0.5, v * half * (a.muted ? 1 : Math.max(0.2, a.volume ?? 1)));
                ctx.fillRect(x, mid - hgt, 1, hgt * 2);
            }
        }
        if (a.id === selClip) { ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.5, y + 3.5, x1 - x0 - 1, ROW_H - 7); ctx.lineWidth = 1; }
        ctx.fillStyle = css("--vps-text");
        ctx.font = "11px sans-serif"; ctx.textBaseline = "middle";
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, y, Math.max(0, x1 - x0), ROW_H); ctx.clip();
        ctx.fillText(a.name ?? "audio", Math.max(x0, 0) + 4, y + ROW_H / 2);
        ctx.restore();
        // クリップの境目(分割した位置)
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(x0, y + 3, 1, ROW_H - 6);
        ctx.fillRect(x1 - 1, y + 3, 1, ROW_H - 6);
    }

    function drawPlayhead(ctx, h, head) {
        const x = Math.round(xOf(tl.current)) + 0.5;
        ctx.strokeStyle = "#ff4757"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        if (head) { ctx.fillStyle = "#ff4757"; ctx.fillRect(x - 4, 0, 8, 6); }
    }

    function niceStep() {
        const target = 60 / pxPerFrame;
        for (const s of [1, 2, 5, 10, 12, 24, 30, 48, 60, 120, 240, 600]) if (s >= target) return s;
        return 1200;
    }

    // ---------------------------------------------------------------- interaction
    function keyAt(x, y) {
        const rs = rows();
        const r = rs[Math.floor(y / ROW_H)];
        if (!r || r.id.startsWith("__audio")) return { row: r };
        const f = frameAt(x);
        const k = tl.keys(r.id).find(k => Math.abs(xOf(k.frame) - x) <= KEY_R + 2);
        return { row: r, key: k, frame: f };
    }

    let drag = null;

    function setDeleteMode(v) {
        deleteMode = v;
        delModeBtn.classList.toggle("on", v);
        tracks.classList.toggle("deleting", v);
        if (v) selected = [];
        draw();
    }

    // 削除モード: x0〜x1(前回と今回のカーソル位置)の間にあるキーを消す。速く動かしても間のキーを飛ばさない
    function eraseKeys(row, x0, x1) {
        if (!row || row.id.startsWith("__audio")) return 0;
        const lo = frameAt(Math.min(x0, x1) - KEY_R - 2), hi = frameAt(Math.max(x0, x1) + KEY_R + 2);
        const hits = tl.keys(row.id).filter(k => k.frame >= lo && k.frame <= hi).map(k => k.frame);
        for (const f of hits) tl.removeKey(row.id, f);
        return hits.length;
    }

    function eraseAt(e) {
        const rect = tracks.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const row = e.shiftKey ? rows()[Math.floor(y / ROW_H)] : drag.row;
        drag.count += eraseKeys(row, drag.lastX ?? x, x);
        drag.lastX = x;
    }

    tracks.addEventListener("pointerdown", e => {
        const rect = tracks.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const hit = keyAt(x, y);
        tracks.setPointerCapture(e.pointerId);
        if (deleteMode) {
            drag = { type: "erase", row: hit.row, lastX: null, count: 0 };
            eraseAt(e);
            return;
        }
        const clip = clipAt(hit.row, x);
        if (clip) {
            selClip = clip.id;
            drag = { type: "audio", clip, startX: x, offset: clip.offset || 0 };
            draw();
            return;
        }
        selClip = null;
        if (hit.key) {
            const item = { trackId: hit.row.id, frame: hit.key.frame };
            const already = selected.some(s => s.trackId === item.trackId && s.frame === item.frame);
            if (e.shiftKey) selected = already ? selected.filter(s => !(s.trackId === item.trackId && s.frame === item.frame)) : [...selected, item];
            else if (!already) selected = [item];
            easeSel.value = hit.key.ease;
            drag = { type: "keys", startX: x, delta: 0 };
            if (hit.row.owner !== studio.selection?.id) studio.select(hit.row.owner);
            studio.seek(hit.key.frame);
        } else {
            if (!e.shiftKey) selected = [];
            drag = { type: "scrub" };
            studio.seek(Math.round(frameAt(x)));
        }
        draw();
    });
    tracks.addEventListener("pointermove", e => {
        if (!drag) return;
        const x = e.clientX - tracks.getBoundingClientRect().left;
        if (drag.type === "erase") { eraseAt(e); return; }
        if (drag.type === "scrub") studio.seek(Math.round(frameAt(x)));
        else if (drag.type === "keys") {
            drag.delta = Math.round((x - drag.startX) / pxPerFrame);
            drawGhost(drag.delta);
        } else if (drag.type === "audio") {
            // 0 秒より前には置けない(頭を使わないときは分割して外す)
            drag.clip.offset = Math.max(0, +(drag.offset + (x - drag.startX) / pxPerFrame / tl.fps).toFixed(3));
            draw();
        }
    });
    tracks.addEventListener("pointerup", () => {
        // なぞって消した分は 1 回の Undo で戻る
        if (drag?.type === "erase" && drag.count) {
            selected = [];
            studio.seek(tl.current);
            studio.commitEdit({ key: false });
        }
        if (drag?.type === "keys" && drag.delta) {
            selected = tl.moveKeys(selected, drag.delta);
            studio.seek(Math.round(tl.current + drag.delta));
            studio.commitEdit({ key: false });
        }
        if (drag?.type === "audio") studio.setAudioOffset(drag.clip.id, drag.clip.offset);
        drag = null;
        draw();
    });
    tracks.addEventListener("dblclick", e => {
        const rect = tracks.getBoundingClientRect();
        if (deleteMode) return;
        const hit = keyAt(e.clientX - rect.left, e.clientY - rect.top);
        if (!hit.row || hit.key) return;
        if (hit.row.id.startsWith("__audio")) { if (!hit.row.clips) chooseAudio(); return; }
        studio.seek(Math.round(hit.frame));
        if (hit.row.id === CUT_TRACK) {
            const sel = studio.selection?.id;
            studio.setCut(studio.isCamera(sel) ? sel : studio.cams.viewId);
        } else studio.keyTrack(hit.row.id);
    });

    function drawGhost(delta) {
        draw();
        const ctx = tracks.getContext("2d");
        const rs = rows();
        ctx.fillStyle = "rgba(255,210,74,0.5)";
        for (const s of selected) {
            const i = rs.findIndex(r => r.id === s.trackId);
            if (i < 0) continue;
            const x = xOf(s.frame + delta), cy = i * ROW_H + ROW_H / 2;
            ctx.beginPath(); ctx.arc(x, cy, KEY_R, 0, Math.PI * 2); ctx.fill();
        }
    }

    let rulerDrag = false;
    ruler.addEventListener("pointerdown", e => { rulerDrag = true; ruler.setPointerCapture(e.pointerId); studio.seek(Math.round(frameAt(e.offsetX))); });
    ruler.addEventListener("pointermove", e => { if (rulerDrag) studio.seek(Math.round(frameAt(e.offsetX))); });
    ruler.addEventListener("pointerup", () => (rulerDrag = false));

    const onWheel = e => {
        if (e.ctrlKey) {
            e.preventDefault();
            const x = e.offsetX;
            const f = frameAt(x);
            pxPerFrame = Math.min(40, Math.max(0.5, pxPerFrame * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            scrollX = Math.max(0, f - x / pxPerFrame);
            draw();
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.currentTarget === ruler) {
            e.preventDefault();
            scrollX = Math.max(0, scrollX + (e.deltaX || e.deltaY) / pxPerFrame);
            draw();
        }
    };
    tracks.addEventListener("wheel", onWheel, { passive: false });
    ruler.addEventListener("wheel", onWheel, { passive: false });

    // ---------------------------------------------------------------- actions
    // 選んだキー(なければ選んだ音声トラック)を消す。何か消したら true
    function deleteSelected() {
        if (!selected.length) {
            if (selClip && studio.audioClip(selClip)) { removeClip(selClip); return true; }
            return false;
        }
        for (const s of selected) tl.removeKey(s.trackId, s.frame);
        selected = [];
        studio.seek(tl.current);
        studio.commitEdit({ key: false });
        return true;
    }

    function removeClip(id) {
        studio.removeAudio(id);
        if (selClip === id) selClip = null;
    }

    function removeTrack(track) {
        if (studio.audios.some(c => c.id === selClip && c.track === track)) selClip = null;
        studio.removeAudioTrack(track);
    }

    // 再生位置で音声を分割する。選んでいるクリップが再生位置にかかっていればそれだけ、なければ再生位置にかかる全部
    async function splitAudio() {
        const sec = Math.round(tl.current) / tl.fps;
        const covers = c => sec > c.offset && sec < c.offset + clipLength(c);
        const sel = studio.audioClip(selClip);
        const targets = sel && covers(sel) ? [sel] : studio.audios.filter(covers);
        if (!targets.length) { toast(t("splitAudioNone")); return; }
        let last = null;
        for (const c of targets) last = (await studio.splitAudio(c.id, sec)) ?? last;
        if (last) selClip = last.id;
        draw();
    }

    // 波形を見ながら分割する。対象は選んでいるクリップ → 再生位置にかかるクリップ → 1 つしかなければそれ
    async function openSplit() {
        const sec = tl.current / tl.fps;
        const covers = c => sec > c.offset && sec < c.offset + clipLength(c);
        const clip = studio.audioClip(selClip) ?? studio.audios.find(covers) ?? (studio.audios.length === 1 ? studio.audios[0] : null);
        if (!clip) { toast(t(studio.audios.length ? "splitAudioPick" : "splitAudioNone")); return; }
        const next = await openAudioSplit(studio, clip, covers(clip) ? sec - clip.offset : undefined);
        if (next) { selClip = next.id; draw(); }
    }

    function copyKeys() {
        if (!selected.length) return;
        const base = Math.min(...selected.map(s => s.frame));
        clipboard = {
            items: selected.map(s => ({ trackId: s.trackId, dframe: s.frame - base, key: structuredClone(tl.keys(s.trackId).find(k => k.frame === s.frame)) })).filter(i => i.key),
        };
        toast(`${clipboard.items.length} keys`);
    }

    function pasteKeys() {
        if (!clipboard) return;
        const at = Math.round(tl.current);
        // 1 トラック分だけコピーしたときは、選択中のオブジェクトへ貼り付けられる(同じ種類どうし)
        const tracksInClip = new Set(clipboard.items.map(i => i.trackId));
        const target = studio.selection?.id;
        let remap = null;
        if (tracksInClip.size === 1 && target) {
            const src = [...tracksInClip][0];
            const { ch } = parseTrack(src);
            // 目・まばたき・口パクは、選択中の人物の同じ子トラックへ
            if (ch) remap = studio.get(target)?.type === "actor" ? channelTrack(target, ch) : null;
            else if (sameKind(src, target)) remap = target;
        }
        selected = [];
        for (const i of clipboard.items) {
            const tid = remap ?? i.trackId;
            let state = i.key.state;
            // 別の人物・プロップへ貼るときは、置き場所(変換)は貼り付け先のものを使う
            if (remap && remap !== i.trackId && state.transform) state = { ...state, transform: studio.get(remap).getState().transform };
            tl.setKey(tid, at + i.dframe, state, i.key.ease);
            selected.push({ trackId: tid, frame: at + i.dframe });
        }
        studio.seek(at);
        studio.commitEdit({ key: false });
    }

    function sameKind(a, b) {
        if (studio.isCamera(a) && studio.isCamera(b)) return true;
        if ([a, b].some(x => x === SCENE_TRACK || x === WIND_TRACK || x === CUT_TRACK || studio.isCamera(x))) return a === b;
        const oa = studio.get(a), ob = studio.get(b);
        return oa && ob && oa.type === ob.type;
    }

    function setRange(which) {
        const [s, e] = tl.range ?? [0, tl.frames];
        const f = Math.round(tl.current);
        tl.range = which === 0 ? [f, Math.max(f + 1, e)] : [Math.min(s, f - 1), f];
        tl._changed();
        studio.commitEdit({ key: false });
    }

    // 音声トラックを足す(今の時刻から)
    async function chooseAudio() {
        const it = await pickAsset("audio", { title: t("addAudioTrack") });
        if (!it) return;
        const clip = await studio.addAudio({ url: it.url, name: it.name, source: it.source, path: it.path, offset: tl.current / tl.fps });
        selClip = clip.id;
        // 音声の長さに合わせてタイムラインを伸ばす
        const end = Math.ceil(((clip.offset || 0) + (clip.duration || 0)) * tl.fps);
        if (end > tl.frames) studio.setTimelineLength(end);
    }

    function syncToolbar() {
        playBtn.textContent = studio.playing ? "⏸" : "▶";
        autoKeyBtn.classList.toggle("on", studio.autoKey);
        loopBtn.classList.toggle("on", studio.loop);
        if (document.activeElement !== frameInput) frameInput.value = Math.round(tl.current);
        timeLabel.textContent = fmtTime(tl.current / tl.fps);
        fpsSel.value = String(tl.fps);
        if (document.activeElement !== lenInput) lenInput.value = tl.frames;
        lenSec.textContent = `${t("frames")} (${(tl.frames / tl.fps).toFixed(2)}s)`;
        audioBtn.classList.toggle("on", studio.audios.length > 0);
    }

    // 再生中は再生位置が見えるようにスクロール
    function follow() {
        const w = tracks.parentElement.clientWidth;
        const x = xOf(tl.current);
        if (x > w - 20 || x < 0) scrollX = Math.max(0, tl.current - 10);
    }

    let raf = 0;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (studio.playing) follow(); syncToolbar(); draw(); }); };
    for (const ev of ["frame", "timeline", "objects", "selection", "playing", "cameras"]) studio.addEventListener(ev, schedule);
    // シーンのオブジェクトを選んだら音声トラックの選択は外す(Delete の対象を 1 つにする)
    studio.addEventListener("selection", () => { selClip = null; });
    new ResizeObserver(schedule).observe(root);
    scroll.addEventListener("scroll", schedule);

    // ショートカット(app.js から呼ぶ)
    return {
        deleteSelected,
        copyKeys, pasteKeys,
        splitAudio,
        hasSelection: () => selected.length > 0,
        // Esc で削除モードを抜ける(抜けたら true)
        exitDeleteMode: () => { if (!deleteMode) return false; setDeleteMode(false); return true; },
        redraw: schedule,
    };
}
