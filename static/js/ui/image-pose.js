// image-pose.js — 画像 / 動画 → SAM 3D Body(ComfyUI ネイティブノード)→ 人物のポーズ / モーション
//
// 推定は 3D Pose Editor と同じく ComfyUI のワークフローとして実行する(SAM 3D Body のコード・重みは同梱しない)。
//   画像: openpose / body_mesh の GLB → ソルバーで VRM の回転を解いて選択中の人物に適用
//   動画: BVH → 取り込み設定ダイアログ → 人物のキーフレーム
// UI はビューポートとプロパティの間に開くパネル。元の画像・動画を横に置いたまま(またはビューポートに重ねて)
// モデルと見比べられる。動画はモーションを取り込んだ位置からタイムラインに同期して再生する。

import { t, getLang } from "../i18n.js";
import { el, toast, slider, pickFile } from "../util.js";
import { pickAsset } from "./assets.js";
import { checkSam3dAvailable, runSam3d, runSam3dVideo } from "../lib/image_pose.js";
import { parseMeshHands, parseOpenposeGlb, samToPose, solvePose, defaultSolveOptions, captureRig, applySolvedPose } from "../lib/image_pose_solver.js";
import { peekBvh } from "../lib/bvh_retarget.js";
import { askBvhImportOptions } from "../lib/bvh_import_dialog.js";

const VIDEO_EXT = ["mp4", "webm", "mov", "mkv"];
const OPEN_KEY = "vps:imagePoseOpen";

const state = {
    file: null,          // Blob
    url: "",             // file の object URL
    name: "",
    isVideo: false,
    sam: null,           // parseOpenposeGlb の結果
    hands: null,         // parseMeshHands の結果
    opts: { ...defaultSolveOptions, useHands: true, ground: true },
    videoStart: 0,
    videoLength: 10,
    sync: null,          // { frame, sec }: タイムラインの frame に動画の sec を合わせる
    overlay: false,
    overlayOpacity: 0.5,
};

// 解いた回転を人物に適用する。applySolvedPose は editor.importPose(JSON) を呼ぶので、その受け口を用意する
function applyToActor(studio, actor) {
    const vrm = actor.vrm;
    const hands = state.opts.useHands ? state.hands : null;
    const input = {
        pose: samToPose(state.sam, hands),
        leftHand: hands?.left, rightHand: hands?.right,
        leftHandSide: hands?.leftSide, rightHandSide: hands?.rightSide,
    };
    const rig = captureRig(vrm);
    const res = solvePose(input, rig, state.opts);
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    const editor = {
        importPose(json) {
            // 接地補正で持ち上げた腰の高さは JSON に入らないので、適用後に戻す
            const hipsPos = hips.position.clone();
            actor.importPoseJson(JSON.parse(json));
            hips.position.copy(hipsPos);
        },
    };
    applySolvedPose(editor, vrm, rig, res.rotations, state.opts.ground);
    actor.resetPhysics();
    studio.commitEdit();
    return res.skipped;
}

// root: スタジオのグリッド内のパネル。onToggle(open) は開閉のたびに呼ばれる(ツールバーのボタン表示用)
export function buildImagePosePanel(root, studio, { onToggle } = {}) {
    const section = root.closest(".vps-studio");

    // ---- 画像 / 動画 ----
    const preview = el("div.vps-ip-preview");
    const overlay = el("div.vps-ip-overlay");
    studio.vp.canvas.parentElement.append(overlay);
    const videos = () => [preview, overlay].map(p => p.querySelector("video")).filter(Boolean);

    const media = () => state.isVideo
        ? el("video", { src: state.url, muted: true, loop: !state.sync, playsInline: true })
        : el("img", { src: state.url });
    const showPreview = () => {
        preview.replaceChildren();
        overlay.replaceChildren();
        if (!state.file) { preview.append(el("div.vps-hint", t("ipDrop"))); }
        else {
            const v = media(), ov = media();
            if (state.isVideo) {
                v.controls = true;
                // タイムライン同期していないときは、重ねた動画をパネルの再生に合わせる
                const follow = () => {
                    if (state.sync && syncChk.checked) return;
                    if (Math.abs(ov.currentTime - v.currentTime) > 0.1) ov.currentTime = v.currentTime;
                    if (v.paused !== ov.paused) v.paused ? ov.pause() : ov.play().catch(() => {});
                };
                for (const ev of ["play", "pause", "seeked", "timeupdate"]) v.addEventListener(ev, follow);
            }
            preview.append(v, el("div.vps-ip-name", state.name));
            overlay.append(ov);
        }
        videoRows.classList.toggle("hidden", !state.isVideo);
        syncRow.classList.toggle("hidden", !state.sync);
        syncOverlay();
        syncVideo();
    };
    const setFile = (blob, name) => {
        if (state.url) URL.revokeObjectURL(state.url);
        state.file = blob;
        state.url = URL.createObjectURL(blob);
        state.name = name;
        state.isVideo = VIDEO_EXT.includes(name.toLowerCase().split(".").pop());
        state.sam = null;
        state.hands = null;
        state.sync = null;
        showPreview();
        refreshButtons();
    };
    preview.addEventListener("dragover", e => { e.preventDefault(); preview.classList.add("drag"); });
    preview.addEventListener("dragleave", () => preview.classList.remove("drag"));
    preview.addEventListener("drop", e => {
        e.preventDefault();
        e.stopPropagation(); // ビューポート側のドロップ(アセット化)に渡さない
        preview.classList.remove("drag");
        const f = e.dataTransfer.files[0];
        if (f) setFile(f, f.name);
    });
    const sources = el("div.vps-btn-row",
        el("button.vps-btn.small", { onclick: async () => { const [f] = await pickFile("image/*,video/*"); if (f) setFile(f, f.name); } }, `📁 ${t("chooseFile")}`),
        el("button.vps-btn.small", {
            onclick: async () => {
                const it = await pickAsset("backgrounds", { title: t("ipFromAssets") });
                if (!it) return;
                const blob = await (await fetch(it.url)).blob();
                setFile(blob, it.name);
            },
        }, `🖼 ${t("ipFromAssets")}`),
        el("button.vps-btn.small", {
            onclick: async () => {
                // ビューポートの今の絵(背景込み)を使う
                const blob = await studio.captureStill();
                setFile(blob, "viewport.png");
            },
        }, `📸 ${t("ipFromViewport")}`),
    );

    // ---- 見比べ: ビューポートに重ねる / タイムライン同期 ----
    const overlayChk = el("input", { type: "checkbox", checked: state.overlay, onchange: () => { state.overlay = overlayChk.checked; syncOverlay(); } });
    const overlayRow = el("div.vps-ip-compare",
        el("label.vps-check", { title: t("ipOverlayHint") }, overlayChk, el("span", t("ipOverlay"))),
        slider({ label: t("opacity"), min: 0.05, max: 1, step: 0.05, value: state.overlayOpacity, onInput: v => { state.overlayOpacity = v; syncOverlay(); } }),
    );
    const syncChk = el("input", { type: "checkbox", checked: true, onchange: () => syncVideo() });
    const syncRow = el("label.vps-check.hidden", { title: t("ipSyncHint") }, syncChk, el("span", t("ipSync")));

    // 重ねる絵は出力サイズの枠と同じ位置・大きさにする(画像は縦横比を保って中央)
    function syncOverlay() {
        const c = studio.vp.canvas, fr = studio.vp.frameRect;
        overlay.hidden = !(isOpen() && state.overlay && state.file);
        Object.assign(overlay.style, {
            left: `${c.offsetLeft + fr.x}px`, top: `${c.offsetTop + fr.y}px`, width: `${fr.width}px`, height: `${fr.height}px`,
            opacity: state.overlayOpacity,
            transform: state.opts.mirror ? "scaleX(-1)" : "",
        });
    }
    studio.vp.addEventListener("resize", syncOverlay);

    // 取り込んだモーションの先頭フレーム = 動画の推定開始位置
    function syncVideo() {
        if (!state.sync || !syncChk.checked || !isOpen()) return;
        const tl = studio.timeline;
        const sec = state.sync.sec + (tl.current - state.sync.frame) / tl.fps;
        for (const v of videos()) {
            const d = Number.isFinite(v.duration) ? v.duration : Infinity;
            const tt = Math.max(0, Math.min(d, sec));
            const inside = sec >= 0 && sec <= d;
            if (studio.playing && inside) {
                if (v.paused) { v.currentTime = tt; v.play().catch(() => {}); }
                else if (Math.abs(v.currentTime - tt) > 0.25) v.currentTime = tt;
            } else {
                if (!v.paused) v.pause();
                if (Math.abs(v.currentTime - tt) > 0.01) v.currentTime = tt;
            }
        }
    }
    studio.addEventListener("frame", syncVideo);
    studio.addEventListener("playing", syncVideo);

    // ---- 実行とオプション ----
    const actorSel = el("select.vps-select");
    const syncActors = () => {
        const cur = actorSel.value || studio.selectedObject()?.id;
        actorSel.replaceChildren(...studio.actors().map(a => el("option", { value: a.id, selected: a.id === cur }, a.name)));
        refreshButtons();
    };
    studio.addEventListener("objects", syncActors);
    studio.addEventListener("selection", () => {
        const o = studio.selectedObject();
        if (o?.type === "actor" && !busy) actorSel.value = o.id;
    });

    const modelSel = el("select.vps-select");
    const status = el("div.vps-ip-status");
    const setStatus = (msg, kind = "") => { status.textContent = msg; status.className = `vps-ip-status ${kind}`; };

    const o = state.opts;
    const check = (key, label, hint, after) => {
        const c = el("input", { type: "checkbox", checked: !!o[key], onchange: () => { o[key] = c.checked; after?.(); reapply(); } });
        return el("label.vps-check", { title: hint ?? "" }, c, el("span", label));
    };
    const startIn = el("input.vps-num", { type: "number", min: 0, step: 0.5, value: state.videoStart, onchange: () => (state.videoStart = +startIn.value) });
    const lenIn = el("input.vps-num", { type: "number", min: 0.5, step: 0.5, value: state.videoLength, onchange: () => (state.videoLength = +lenIn.value) });
    const videoRows = el("div.vps-form-group.hidden",
        el("label.vps-field", el("span.vps-label", `${t("start")} / ${t("length")} (s)`), el("div.vps-vec3", startIn, lenIn)),
        el("div.vps-hint", t("ipVideoHint")),
    );

    let busy = false;
    let abort = null;
    const runBtn = el("button.vps-btn.primary", { onclick: () => run() }, `▶ ${t("ipRun")}`);
    const applyBtn = el("button.vps-btn", { onclick: () => reapply(true) }, t("ipReapply"));
    const cancelBtn = el("button.vps-btn", { onclick: () => abort?.abort() }, t("cancel"));
    function refreshButtons() {
        runBtn.disabled = busy || !state.file || !modelSel.value || !actorSel.value;
        applyBtn.disabled = busy || !state.sam || !actorSel.value;
        cancelBtn.disabled = !busy;
    }

    const close = () => setOpen(false);
    root.append(
        el("div.vps-panel-title.vps-ip-head", el("span", `🖼 ${t("imagePose")}`),
            el("button.vps-icon-btn", { title: t("close"), onclick: close }, "✕")),
        el("div.vps-ip-body",
            preview, sources, overlayRow, syncRow,
            el("label.vps-field", el("span.vps-label", t("ipTarget")), actorSel),
            el("label.vps-field", el("span.vps-label", "SAM 3D Body"), modelSel),
            videoRows,
            el("div.vps-btn-row", runBtn, applyBtn, cancelBtn),
            status,
            el("h4.vps-settings-h", t("ipOptions")),
            check("mirror", t("ipMirror"), t("ipMirrorHint"), syncOverlay),
            check("useHands", t("ipHands")),
            check("fingers", t("ipFingers")),
            check("removeYaw", t("ipRemoveYaw"), t("ipRemoveYawHint")),
            check("ground", t("ipGround")),
            slider({ label: t("ipHeadPitch"), min: -30, max: 45, step: 1, value: o.headPitchDeg, onChange: v => { o.headPitchDeg = v; reapply(); } }),
            slider({ label: t("ipTwist"), min: 0, max: 1, step: 0.05, value: o.twistSplit, onChange: v => { o.twistSplit = v; reapply(); } }),
            el("div.vps-hint", t("ipLicense")),
        ),
    );

    const target = () => studio.get(actorSel.value);

    function reapply(manual) {
        if (!state.sam || busy) return;
        const a = target();
        if (!a?.vrm) return;
        const skipped = applyToActor(studio, a);
        if (manual || skipped.length) setStatus(`${t("ipApplied")}${skipped.length ? ` (${t("ipSkipped")}: ${skipped.join(", ")})` : ""}`, "ok");
    }

    async function run() {
        const a = target();
        if (!a?.vrm || !state.file) return;
        busy = true;
        abort = new AbortController();
        refreshButtons();
        const t0 = performance.now();
        const ext = (state.name.split(".").pop() ?? "png").toLowerCase();
        try {
            if (state.isVideo) {
                const range = { startSec: state.videoStart, durationSec: state.videoLength };
                const r = await runSam3dVideo(state.file, ext, modelSel.value, range, msg => setStatus(msg), abort.signal);
                setStatus(t("ipBvhReceived"));
                const opts = await askBvhImportOptions(r.filename, getLang(), peekBvh(r.text));
                if (!opts) { setStatus(`${t("cancel")} (output/3d/${r.filename})`); return; }
                const frame = Math.round(studio.timeline.current);
                const n = await studio.importBvh(a.id, r.text, opts, { startFrame: frame, every: 1 });
                state.sync = { frame, sec: range.startSec };
                syncChk.checked = true;
                showPreview();
                setStatus(`${t("ipMotionDone")}: ${n} keys (${((performance.now() - t0) / 1000).toFixed(1)}s)`, "ok");
            } else {
                const r = await runSam3d(state.file, ext, modelSel.value, msg => setStatus(msg), abort.signal);
                state.hands = parseMeshHands(r.mesh);
                state.sam = parseOpenposeGlb(r.openpose);
                busy = false;
                reapply();
                setStatus(`${t("ipApplied")} (${((performance.now() - t0) / 1000).toFixed(1)}s)`, "ok");
            }
        } catch (e) {
            if (e?.name === "AbortError") setStatus(t("ipAborted"));
            else setStatus(String(e.message ?? e), "error");
        } finally {
            busy = false;
            abort = null;
            refreshButtons();
        }
    }

    // ComfyUI のノード・モデルの確認(最初に開いたとき)
    let checked = false;
    async function checkComfy() {
        if (checked) return;
        checked = true;
        setStatus(t("loading"));
        try {
            const av = await checkSam3dAvailable();
            modelSel.replaceChildren(...av.models.map(m => el("option", { value: m }, m)));
            if (!av.ok) setStatus(av.message, "error");
            else setStatus(av.videoOk ? t("ipReady") : `${t("ipReady")} (${t("ipNoVideo")})`);
        } catch (e) {
            checked = false; // ComfyUI が後から起動したら開き直しで再確認できるように
            setStatus(`${t("ipNoComfy")}: ${e.message}`, "error");
        }
        refreshButtons();
    }

    function isOpen() { return section.classList.contains("ip-open"); }
    function setOpen(v = !isOpen()) {
        section.classList.toggle("ip-open", v);
        try { localStorage.setItem(OPEN_KEY, v ? "1" : ""); } catch { /* ignore */ }
        if (v) {
            const sel = studio.selectedObject();
            if (sel?.type === "actor" && !busy) actorSel.value = sel.id;
            checkComfy();
        } else {
            for (const vid of videos()) vid.pause();
        }
        // グリッドの列が変わってキャンバスの位置が動くので、レイアウト後に合わせ直す
        requestAnimationFrame(() => { syncOverlay(); syncVideo(); });
        onToggle?.(v);
    }

    syncActors();
    showPreview();
    let wasOpen = false;
    try { wasOpen = localStorage.getItem(OPEN_KEY) === "1"; } catch { /* ignore */ }
    if (wasOpen) setOpen(true);
    return { toggle: setOpen, isOpen };
}
