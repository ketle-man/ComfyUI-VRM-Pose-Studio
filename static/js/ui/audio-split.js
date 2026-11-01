// audio-split.js — 音声クリップを波形を見ながら分割するダイアログ
//
// 操作:
//   波形のクリック・ドラッグ … 分割位置
//   ホイール … ズーム / Shift+ホイール … 横スクロール
//   ←→ … 0.01 秒(フレームに合わせるときは 1 フレーム)ずつ / Shift で 10 倍
//   Space … 分割位置から再生・停止 / Enter … 分割

import { t } from "../i18n.js";
import { el, openModal, toast } from "../util.js";
import { clipLength, MIN_CLIP } from "../engine/studio.js";

const H = 200;
const RULER = 18;
const MIN_SPAN = 0.02; // ズームの限界(画面の幅に見せる最短の秒数)

let _ctx = null;
const audioCtx = () => (_ctx ??= new AudioContext());

// url → Promise<{ buf, mono }>。同じファイルは 1 回だけデコードする
const _decoded = new Map();
function decode(url) {
    if (!_decoded.has(url)) {
        _decoded.set(url, fetch(url).then(r => r.arrayBuffer()).then(b => audioCtx().decodeAudioData(b)).then(buf => {
            const mono = new Float32Array(buf.length);
            for (let ch = 0; ch < buf.numberOfChannels; ch++) {
                const d = buf.getChannelData(ch);
                for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
            }
            return { buf, mono };
        }).catch(e => { _decoded.delete(url); throw e; }));
    }
    return _decoded.get(url);
}

function niceStep(pps) {
    for (const s of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60]) if (s * pps >= 70) return s;
    return 120;
}

// clip を分割する。at: 分割位置の初期値(クリップの頭からの秒)。分割したら後ろ半分のクリップ、やめたら null
export async function openAudioSplit(studio, clip, at) {
    const tl = studio.timeline;
    const len = clipLength(clip), trim = clip.trim || 0;
    if (len < MIN_CLIP * 2) { toast(t("splitAudioShort")); return null; }

    let data;
    try { data = await decode(clip.url); } catch (e) { toast(`${t("loadFailed")}: ${e.message}`, "error"); return null; }

    const clampCur = s => Math.min(len - MIN_CLIP, Math.max(MIN_CLIP, s));
    let cur = clampCur(at ?? len / 2);   // 分割位置(クリップの頭からの秒)
    let view = [0, len];                 // 見えている範囲(クリップの頭からの秒)
    let snap = false;
    let playing = null;                  // { src, t0, from }
    let raf = 0;

    const canvas = el("canvas", { style: { width: "100%", height: `${H}px`, display: "block", cursor: "crosshair", background: "var(--vps-bg)", borderRadius: "4px", touchAction: "none" } });
    const info = el("div.vps-hint", { style: { fontVariantNumeric: "tabular-nums" } });
    const snapBox = el("input", { type: "checkbox", onchange: () => { snap = snapBox.checked; setCur(cur); } });
    const playBtn = el("button.vps-btn.small", { title: "Space", onclick: () => (playing ? stop() : play(cur)) });
    const splitBtn = el("button.vps-btn.primary", { title: "Enter", onclick: () => doSplit() }, `✂ ${t("splitAudio")}`);

    const zoom = (factor, center = (view[0] + view[1]) / 2) => {
        const span = Math.min(len, Math.max(MIN_SPAN, (view[1] - view[0]) * factor));
        const r = (center - view[0]) / (view[1] - view[0]);
        let v0 = center - span * r;
        v0 = Math.max(0, Math.min(len - span, v0));
        view = [v0, v0 + span];
        draw();
    };
    const pan = dsec => {
        const span = view[1] - view[0];
        const v0 = Math.max(0, Math.min(len - span, view[0] + dsec));
        view = [v0, v0 + span];
        draw();
    };

    const body = el("div.vps-split",
        el("div.vps-btn-row",
            el("button.vps-btn.small", { title: t("splitPlayAll"), onclick: () => play(0) }, `⏮ ${t("splitPlayAll")}`),
            playBtn,
            el("button.vps-btn.small", { title: t("splitPlayBefore"), onclick: () => play(Math.max(0, cur - 1.5), cur - Math.max(0, cur - 1.5)) }, `◀| ${t("splitPlayBefore")}`),
            el("span.vps-sep"),
            el("button.vps-btn.small", { onclick: () => zoom(1 / 2, cur) }, "🔍＋"),
            el("button.vps-btn.small", { onclick: () => zoom(2, cur) }, "🔍－"),
            el("button.vps-btn.small", { onclick: () => { view = [0, len]; draw(); } }, t("splitZoomFit")),
            el("span.vps-sep"),
            el("button.vps-btn.small", { title: t("splitToPlayheadTip"), onclick: () => toPlayhead() }, `⇥ ${t("splitToPlayhead")}`),
            el("label.vps-check", snapBox, el("span", t("splitSnap"))),
        ),
        canvas,
        info,
        el("div.vps-hint", t("splitHint")),
    );

    function setCur(s) {
        if (snap) {
            // タイムラインのフレームの境目に合わせる
            const f = Math.round((clip.offset + s) * tl.fps);
            s = f / tl.fps - clip.offset;
            if (s < MIN_CLIP) s += 1 / tl.fps;
            if (s > len - MIN_CLIP) s -= 1 / tl.fps;
        }
        cur = clampCur(s);
        // 分割位置が見えなくなったら追いかける
        if (cur < view[0] || cur > view[1]) pan(cur - (view[0] + view[1]) / 2);
        draw();
    }

    function toPlayhead() {
        const s = tl.current / tl.fps - clip.offset;
        if (s <= 0 || s >= len) { toast(t("splitPlayheadOutside")); return; }
        setCur(s);
    }

    // from: クリップの頭からの秒。dur を省くとクリップの終わりまで
    function play(from, dur) {
        stop();
        const ac = audioCtx();
        ac.resume();
        const src = ac.createBufferSource();
        src.buffer = data.buf;
        const gain = ac.createGain();
        gain.gain.value = Math.max(0, Math.min(1, clip.volume ?? 1));
        src.connect(gain).connect(ac.destination);
        src.start(0, trim + from, dur ?? len - from);
        playing = { src, t0: ac.currentTime, from };
        src.onended = () => { if (playing?.src === src) { playing = null; draw(); } };
        const tick = () => { draw(); if (playing) raf = requestAnimationFrame(tick); };
        raf = requestAnimationFrame(tick);
    }

    function stop() {
        cancelAnimationFrame(raf);
        if (playing) { const p = playing; playing = null; try { p.src.stop(); } catch { /* 停止済み */ } }
        draw();
    }

    function draw() {
        playBtn.textContent = playing ? `■ ${t("splitStop")}` : `▶ ${t("splitPlayFrom")}`;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || 800;
        if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(H * dpr); }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        ctx.clearRect(0, 0, w, H);

        const [v0, v1] = view;
        const pps = w / (v1 - v0);
        const X = s => (s - v0) * pps;

        // 波形(前半と後半で色を変える)
        const { buf, mono } = data;
        const sr = buf.sampleRate;
        const mid = RULER + (H - RULER) / 2, amp = (H - RULER) / 2 - 4;
        const cx = X(cur);
        for (let x = 0; x < w; x++) {
            const s0 = trim + v0 + x / pps;
            const i0 = Math.floor(s0 * sr), i1 = Math.max(i0 + 1, Math.floor((s0 + 1 / pps) * sr));
            const stride = Math.max(1, Math.floor((i1 - i0) / 1500));
            let lo = 0, hi = 0;
            for (let i = i0; i < i1 && i < mono.length; i += stride) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
            ctx.fillStyle = x < cx ? "rgba(46,213,115,0.85)" : "rgba(74,158,255,0.85)";
            ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(0, mid, w, 1);

        // 目盛り(タイムラインの秒)。拡大したらフレームの目盛りも出す
        ctx.fillStyle = css("--vps-bg-2") || "#222";
        ctx.fillRect(0, 0, w, RULER);
        ctx.strokeStyle = css("--vps-border") || "#555";
        ctx.fillStyle = css("--vps-text-2") || "#aaa";
        ctx.font = "10px sans-serif"; ctx.textBaseline = "top";
        const fpx = pps / tl.fps;
        if (fpx >= 6) {
            ctx.strokeStyle = "rgba(255,255,255,0.12)";
            for (let f = Math.ceil((clip.offset + v0) * tl.fps); f / tl.fps - clip.offset <= v1; f++) {
                const x = Math.round(X(f / tl.fps - clip.offset)) + 0.5;
                ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke();
                if (fpx >= 28) ctx.fillText(`${f}f`, x + 2, RULER + 2);
            }
        }
        const step = niceStep(pps);
        ctx.strokeStyle = css("--vps-border") || "#555";
        const g0 = Math.ceil((clip.offset + v0) / step) * step;
        for (let g = g0; g - clip.offset <= v1 + 1e-9; g += step) {
            const x = Math.round(X(g - clip.offset)) + 0.5;
            ctx.beginPath(); ctx.moveTo(x, RULER - 6); ctx.lineTo(x, RULER); ctx.stroke();
            ctx.fillText(`${+g.toFixed(3)}s`, x + 2, 3);
        }

        // 再生中の位置
        if (playing) {
            const p = playing.from + (audioCtx().currentTime - playing.t0);
            ctx.fillStyle = "#ffd24a";
            ctx.fillRect(Math.round(X(p)), RULER, 1, H - RULER);
        }
        // 分割位置
        ctx.fillStyle = "#ff4757";
        ctx.fillRect(Math.round(cx) - 1, 0, 2, H);
        ctx.beginPath(); ctx.moveTo(cx - 6, 0); ctx.lineTo(cx + 6, 0); ctx.lineTo(cx, 8); ctx.closePath(); ctx.fill();

        const at = clip.offset + cur;
        info.textContent = `${t("splitAt")}: ${at.toFixed(3)} s (${(at * tl.fps).toFixed(1)} f)　`
            + `${t("splitFirst")} ${cur.toFixed(3)} s ／ ${t("splitSecond")} ${(len - cur).toFixed(3)} s`;
    }

    // ---- 操作 ----
    let dragging = false;
    const secAt = e => view[0] + (e.clientX - canvas.getBoundingClientRect().left) / (canvas.clientWidth / (view[1] - view[0]));
    canvas.addEventListener("pointerdown", e => { dragging = true; canvas.setPointerCapture(e.pointerId); setCur(secAt(e)); });
    canvas.addEventListener("pointermove", e => { if (dragging) setCur(secAt(e)); });
    canvas.addEventListener("pointerup", () => (dragging = false));
    canvas.addEventListener("wheel", e => {
        e.preventDefault();
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) pan(((e.deltaX || e.deltaY) / canvas.clientWidth) * (view[1] - view[0]));
        else zoom(e.deltaY < 0 ? 1 / 1.25 : 1.25, secAt(e));
    }, { passive: false });

    const onKey = e => {
        if (e.target.closest?.("input:not([type=checkbox]), textarea")) return;
        const nudge = (snap ? 1 / tl.fps : 0.01) * (e.shiftKey ? 10 : 1);
        if (e.key === "ArrowLeft") { e.preventDefault(); setCur(cur - nudge); }
        else if (e.key === "ArrowRight") { e.preventDefault(); setCur(cur + nudge); }
        else if (e.key === " ") { e.preventDefault(); playing ? stop() : play(cur); }
        else if (e.key === "Enter") { e.preventDefault(); doSplit(); }
    };

    let resolve, done = false;
    const result = new Promise(r => (resolve = r));
    const finish = v => {
        if (done) return;
        done = true;
        stop();
        document.removeEventListener("keydown", onKey);
        resizeObs.disconnect();
        modal.close();
        resolve(v);
    };
    async function doSplit() {
        if (splitBtn.disabled) return;
        splitBtn.disabled = true;
        finish(await studio.splitAudio(clip.id, clip.offset + cur));
    }

    const modal = openModal(`✂ ${t("splitDialogTitle")} — ${clip.name}`, body, {
        wide: true,
        onClose: () => finish(null),
        footer: [el("button.vps-btn", { onclick: () => finish(null) }, t("cancel")), splitBtn],
    });
    document.addEventListener("keydown", onKey);
    const resizeObs = new ResizeObserver(() => draw());
    resizeObs.observe(canvas);
    draw();
    return result;
}
