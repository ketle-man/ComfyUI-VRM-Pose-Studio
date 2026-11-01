// time-stretch.js — タイムストレッチのダイアログ(3D Pose Editor の ⏱ Stretch と同じ)
//
// 範囲内のキーの間隔を伸縮して、動きを遅く/速くする。計算は engine/timeline.js の stretchFrame / planTrackStretch。
// 元に戻すのは通常の Undo(Ctrl+Z)。

import { t } from "../i18n.js";
import { el, openModal, toast } from "../util.js";
import { SCENE_TRACK, WIND_TRACK, CHANNELS, channelTrack, parseTrack, planTrackStretch } from "../engine/timeline.js";
import { CUT_TRACK } from "../engine/cameras.js";

export function openTimeStretch(studio) {
    if (studio.playing) studio.play(false);
    const tl = studio.timeline;
    const selId = studio.selection?.id;
    const allIds = () => Object.keys(tl.tracks);
    const trackLabel = id => parseTrack(id).ch ? `${studio.get(parseTrack(id).owner)?.name ?? id} / ${t(`ch${parseTrack(id).ch[0].toUpperCase()}${parseTrack(id).ch.slice(1)}`)}`
        : id === WIND_TRACK ? `🌬 ${t("wind")}`
        : id === SCENE_TRACK ? `🌄 ${t("scene")}`
        : id === CUT_TRACK ? `🎬 ${t("cut")}`
        : studio.isCamera(id) ? `🎥 ${studio.cams.get(id)?.name ?? id}`
        : studio.get(id)?.name ?? id;

    const num = (value, attrs = {}) => el("input.vps-num", { type: "number", min: 0, step: 1, value, ...attrs });
    const allRadio = el("input", { type: "radio", name: "vps-stretch-scope", checked: true });
    const oneRadio = el("input", { type: "radio", name: "vps-stretch-scope", disabled: !selId });
    // 選択中だけ: 人物は目・まばたき・口パク、背景・ライトは風も一緒に
    const targetIds = () => (allRadio.checked ? allIds()
        : [selId, ...CHANNELS.map(ch => channelTrack(selId, ch)), ...(selId === SCENE_TRACK ? [WIND_TRACK] : [])].filter(id => id === selId || tl.hasKeys(id)));
    const targetFrames = () => [...new Set(targetIds().flatMap(id => tl.keys(id).map(k => k.frame)))].sort((a, b) => a - b);
    const lastKey = () => { const f = targetFrames(); return f.length ? f[f.length - 1] : tl.frames; };

    // 範囲の初期値: IN / OUT があればそれ、なければ 0〜最後のキー
    const [r0, r1] = tl.range ?? [0, lastKey()];
    const startIn = num(r0), endIn = num(r1);
    const lenIn = num(r1 - r0, { min: 1 }), pctIn = num(100, { min: 1, step: 0.1 });
    const shiftChk = el("input", { type: "checkbox", checked: true });
    const summary = el("div.vps-stretch-summary");
    const okBtn = el("button.vps-btn.primary", { onclick: () => apply() }, t("stretchApply"));

    const readRange = () => ({
        start: Math.max(0, Math.round(+startIn.value || 0)),
        end: Math.max(0, Math.round(+endIn.value || 0)),
        newLength: Math.max(1, Math.round(+lenIn.value || 0)),
        shiftAfter: shiftChk.checked,
    });

    function syncFromLen() {
        const r = readRange();
        if (r.end > r.start) pctIn.value = String(Math.round((r.newLength / (r.end - r.start)) * 1000) / 10);
        refresh();
    }
    function syncFromPct() {
        const r = readRange();
        const pct = Math.max(1, +pctIn.value || 100);
        lenIn.value = String(Math.max(1, Math.round(((r.end - r.start) * pct) / 100)));
        refresh();
    }
    // 実行前に、動くキーと間引くキーの数を見せる
    function refresh() {
        const r = readRange();
        const bad = msg => { summary.textContent = msg; summary.classList.add("error"); okBtn.disabled = true; };
        if (r.end <= r.start) return bad(t("stretchBadRange"));
        // 後ろをずらさないときは、伸ばした先が後ろのキーを追い越すと動きの順番が入れ替わるので止める
        const next = r.shiftAfter ? undefined : targetFrames().find(f => f > r.end);
        if (next !== undefined && r.start + r.newLength >= next) {
            return bad(t("stretchOvertake").replace("{next}", next).replace("{max}", next - r.start - 1));
        }
        let inRange = 0, dropped = 0;
        for (const id of targetIds()) {
            const fr = tl.keys(id).map(k => k.frame);
            inRange += fr.filter(f => f >= r.start && f <= r.end).length;
            dropped += planTrackStretch(fr, r).dropped.length;
        }
        summary.classList.remove("error");
        summary.textContent = `${t("stretchKeysInRange")} ${inRange}: ${r.start}–${r.end} → ${r.start}–${r.start + r.newLength}`
            + (dropped ? `\n${t("stretchDropped").replace("{n}", dropped)}` : "");
        okBtn.disabled = false;
    }

    function apply() {
        const r = readRange();
        if (okBtn.disabled || r.end <= r.start) return;
        // 音声クリップの開始位置は、全トラックを伸縮するときだけ合わせる
        const dropped = studio.stretchTime(r, targetIds(), { moveAudio: allRadio.checked });
        m.close();
        toast(`⏱ ${r.start}–${r.end} → ${r.start}–${r.start + r.newLength}` + (dropped ? ` (${t("stretchDropped").replace("{n}", dropped)})` : ""), "success", 5000);
    }

    for (const i of [startIn, endIn, pctIn]) i.addEventListener("change", syncFromPct);
    lenIn.addEventListener("change", syncFromLen);
    shiftChk.addEventListener("change", refresh);
    for (const r of [allRadio, oneRadio]) r.addEventListener("change", () => { if (!tl.range) endIn.value = String(lastKey()); syncFromPct(); });

    const presets = [50, 75, 150, 200].map(p => el("button.vps-btn.small", { onclick: () => { pctIn.value = String(p); syncFromPct(); } }, `${p}%`));
    const m = openModal(`⏱ ${t("stretchTitle")}`, el("div.vps-form",
        el("div.vps-label", t("stretchScope")),
        el("div.vps-btn-row",
            el("label.vps-check", allRadio, el("span", t("stretchAll"))),
            el("label.vps-check", oneRadio, el("span", selId ? `${t("stretchSelected")} (${trackLabel(selId)})` : t("stretchSelected"))),
        ),
        el("div.vps-label", t("stretchRange")),
        el("div.vps-btn-row",
            el("span", t("start")), startIn, el("span", "〜"), el("span", t("end")), endIn,
            el("button.vps-btn.small", { title: t("stretchWholeTip"), onclick: () => { startIn.value = "0"; endIn.value = String(lastKey()); syncFromPct(); } }, t("stretchWhole")),
            tl.range ? el("button.vps-btn.small", { onclick: () => { [startIn.value, endIn.value] = tl.range.map(String); syncFromPct(); } }, "[ IN / OUT ]") : null,
        ),
        el("div.vps-label", t("stretchNewLength")),
        el("div.vps-btn-row", lenIn, el("span", `${t("frames")} =`), pctIn, el("span", "%"), ...presets),
        el("div.vps-hint", t("stretchHintSpeed")),
        el("label.vps-check", shiftChk, el("span", t("stretchShiftAfter"))),
        summary,
        el("div.vps-hint", t("stretchHint")),
    ), { footer: [el("button.vps-btn", { onclick: () => m.close() }, t("cancel")), okBtn] });
    syncFromPct();
}
