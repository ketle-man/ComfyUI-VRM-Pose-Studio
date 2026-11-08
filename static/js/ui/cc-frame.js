// cc-frame.js — Comic Creator(CC) 連携
// CC のレイアウトタブ「3Dポーズ」の 🎛 Editor(設定で VRM Pose Studio を選んだとき)から開かれると、
// window.opener が CC のページになる。CC は次の関数を公開している(同一オリジンなので直接呼べる):
//   ccGetPanelFrame()          → 送り先のコマの枠 { width, height, points: [[x, y], …](0〜1), label } | null
//   ccReceiveVpsImage(payload) → 撮影画像 { dataUrl, width, height } を送り先のコマへ挿入する(Promise)
// CC からは、開いているスタジオに対して window.vpsApplyCcFrame(frame) を呼んで枠を差し替える。

import { el } from "../util.js";
import { t } from "../i18n.js";

const NS = "http://www.w3.org/2000/svg";

// opener が CC なら返す(別オリジンの opener はプロパティを読むだけで SecurityError になる)
export function ccHost() {
    try {
        return typeof window.opener?.ccReceiveVpsImage === "function" ? window.opener : null;
    } catch {
        return null;
    }
}

// 別ウィンドウ(別 realm)のオブジェクトをこちらの普通のオブジェクトにする
function cloneFrame(frame) {
    if (!frame) return null;
    try { return JSON.parse(JSON.stringify(frame)); } catch { return null; }
}

// 起動時に CC からコマ枠を受け取り、以後の差し替え口(window.vpsApplyCcFrame)を用意する。
// CC から開かれた(コマ枠を受け取った)ら true
export function setupCcBridge(studio) {
    window.vpsApplyCcFrame = frame => studio.setCcFrame(cloneFrame(frame));
    const host = ccHost();
    if (!host) return false;
    let frame = null;
    try { frame = cloneFrame(host.ccGetPanelFrame?.()); } catch { /* ignore */ }
    if (frame) studio.setCcFrame(frame);
    return !!frame;
}

// CC から開いたときの「背景・ライト」の初期状態: 背景を透過、地面を非表示(コマへ載せる素材にするため)。
// 起動時に 1 回だけ。開いたままのスタジオへの枠の差し替え(vpsApplyCcFrame)では変えない
export async function applyCcInitialEnv(studio) {
    await studio.setEnv({ background: { mode: "transparent" }, ground: { visible: false } });
}

// ビューポートのキャンバスに重ねてコマの形を表示する(外側を暗く、輪郭線)。表示専用で、撮影には写らない
export function buildCcFrameOverlay(studio, container) {
    const svg = document.createElementNS(NS, "svg");
    svg.classList.add("vps-cc-frame");
    const shade = document.createElementNS(NS, "path");
    shade.setAttribute("class", "vps-cc-frame-shade");
    shade.setAttribute("fill-rule", "evenodd");
    const line = document.createElementNS(NS, "polygon");
    line.setAttribute("class", "vps-cc-frame-line");
    // コマ名のタグ(枠のいちばん上の頂点に付ける)
    const tag = document.createElementNS(NS, "g");
    tag.setAttribute("class", "vps-cc-frame-tag");
    const tagBg = document.createElementNS(NS, "rect");
    tagBg.setAttribute("rx", 3);
    const tagText = document.createElementNS(NS, "text");
    tag.append(tagBg, tagText);
    svg.append(shade, line, tag);
    container.append(svg);

    const draw = () => {
        const f = studio.ccFrame;
        // 出力サイズの枠(キャンバス内の位置)に重ねる
        const fr = studio.vp.frameRect, cvs = studio.vp.canvas;
        const w = fr.width, h = fr.height;
        if (!f || f.points.length < 3 || !w || !h) { svg.style.display = "none"; return; }
        svg.style.display = "";
        svg.style.left = `${cvs.offsetLeft + fr.x}px`;
        svg.style.top = `${cvs.offsetTop + fr.y}px`;
        svg.setAttribute("width", w);
        svg.setAttribute("height", h);
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        const pts = f.points.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`);
        shade.setAttribute("d", `M0,0H${w}V${h}H0Z M${pts.join(" L")}Z`);
        line.setAttribute("points", pts.join(" "));
        drawTag(f, w, h);
    };

    const drawTag = (f, w, h) => {
        if (!f.label) { tag.style.display = "none"; return; }
        tag.style.display = "";
        tagText.textContent = f.label;
        const padX = 6, tagH = 20;
        const tw = Math.ceil(tagText.getComputedTextLength?.() || f.label.length * 12) + padX * 2;
        // いちばん上(同じ高さなら左)の頂点
        const [vx, vy] = f.points.reduce((a, p) => (p[1] < a[1] || (p[1] === a[1] && p[0] < a[0]) ? p : a));
        const x = Math.min(Math.max(0, vx * w), Math.max(0, w - tw));
        const y = Math.min(Math.max(0, vy * h), Math.max(0, h - tagH));
        tagBg.setAttribute("x", x); tagBg.setAttribute("y", y);
        tagBg.setAttribute("width", tw); tagBg.setAttribute("height", tagH);
        tagText.setAttribute("x", x + padX); tagText.setAttribute("y", y + tagH / 2);
    };
    studio.vp.addEventListener("resize", draw);
    studio.addEventListener("ccframe", draw);
    draw();
}

// ヘッダーの出力サイズ欄に添える「CC のコマ」表示と解除ボタン(コマ枠の適用中だけ見える)
export function buildCcFrameBadge(studio) {
    const label = el("span.vps-cc-badge-label");
    const badge = el("span.vps-cc-badge", { title: t("ccFrameTip") },
        label,
        el("button.vps-btn.small", { title: t("ccFrameReleaseTip"), onclick: () => studio.setCcFrame(null) }, t("ccFrameRelease")));
    const sync = () => {
        const f = studio.ccFrame;
        badge.hidden = !f;
        if (f) label.textContent = `${t("ccFrame")}${f.label ? ` (${f.label})` : ""} ${f.width}×${f.height}`;
    };
    studio.addEventListener("ccframe", sync);
    sync();
    return badge;
}

// 今のフレームを撮って CC の送り先のコマへ挿入する
export async function sendToCc(host, color, studio) {
    const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(color);
    });
    await host.ccReceiveVpsImage({ dataUrl, width: studio.output.width, height: studio.output.height });
}
