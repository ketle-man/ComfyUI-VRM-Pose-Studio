// app.js — VRM Pose Studio SPA の起点(レイアウト・タブ・ヘッダー・ショートカット・ドラッグ&ドロップ)

import { api, kindForFile } from "./api.js";
import { initI18n, t } from "./i18n.js";
import { el, toast, confirmDialog } from "./util.js";
import { Studio } from "./engine/studio.js";
import { buildOutliner, addActorFromAsset, addPropFromAsset } from "./ui/outliner.js";
import { buildInspector } from "./ui/inspector.js";
import { buildTimeline } from "./ui/timeline-ui.js";
import { captureFrame } from "./engine/exporter.js";
import { openExportDialog, openStillDialog, buildRendersTab, saveProject, openProjectDialog, loadProjectByName } from "./ui/export-ui.js";
import { buildHelp } from "./ui/help.js";
import { loadSettings, applySettings, openSettingsDialog, loadDefaultModel } from "./ui/settings.js";
import { importMotion } from "./ui/motion.js";
import { buildGenerateTab } from "./ui/generate.js";
import { buildRegionalTab } from "./ui/regional.js";
import { buildAudioPanel, buildAudioSettings, placeAudio } from "./ui/audio-panel.js";
import { openPoseLibrary } from "./ui/pose-library.js";
import { buildImagePosePanel } from "./ui/image-pose.js";

const settings = await loadSettings();
initI18n(settings.lang);

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- header / tabs
const OUTPUT_PRESETS = [
    ["1:1 1024", 1024, 1024], ["2:3 832×1216", 832, 1216], ["3:2 1216×832", 1216, 832],
    ["9:16 720×1280", 720, 1280], ["16:9 1280×720", 1280, 720], ["16:9 1920×1080", 1920, 1080], ["4:3 1024×768", 1024, 768],
];

// 出力サイズ(幅×高さ + プリセット)。静止画・書き出しの解像度とビューポートの枠になる
function outputSizeControl(studio) {
    const w = el("input.vps-num", { type: "number", min: 64, max: 4096, step: 8, title: t("width") });
    const h = el("input.vps-num", { type: "number", min: 64, max: 4096, step: 8, title: t("height") });
    const presets = el("select.vps-select", { title: t("presets") },
        el("option", { value: "" }, t("presets")),
        OUTPUT_PRESETS.map(([l, pw, ph]) => el("option", { value: `${pw}x${ph}` }, l)));
    const apply = () => studio.setOutputSize(+w.value, +h.value);
    w.addEventListener("change", apply);
    h.addEventListener("change", apply);
    presets.addEventListener("change", () => {
        if (!presets.value) return;
        const [pw, ph] = presets.value.split("x").map(Number);
        studio.setOutputSize(pw, ph);
    });
    const sync = () => {
        const { width, height } = studio.output;
        w.value = width; h.value = height;
        const v = `${width}x${height}`;
        presets.value = OUTPUT_PRESETS.some(([, pw, ph]) => `${pw}x${ph}` === v) ? v : "";
    };
    studio.addEventListener("output", sync);
    sync();
    return el("div.vps-output-size", { title: t("output") }, el("span.vps-output-label", t("output")), w, el("span", "×"), h, presets);
}

function buildHeader(studio) {
    const tabs = [["studio", t("tabStudio")], ["regional", t("tabRegional")], ["generate", t("tabGenerate")], ["renders", t("tabRenders")], ["help", t("tabHelp")]];
    const nav = $("vps-tabs");
    for (const [id, label] of tabs) {
        nav.append(el("button.vps-tab", { dataset: { tab: id }, onclick: () => showTab(id) }, label));
    }
    const projLabel = el("span.vps-project-name");
    const undoBtn = el("button.vps-btn.icon", { title: `${t("undo")} (Ctrl+Z)`, onclick: () => studio.undo() }, "↶");
    const redoBtn = el("button.vps-btn.icon", { title: `${t("redo")} (Ctrl+Y)`, onclick: () => studio.redo() }, "↷");

    // 画面が狭いときはアイコンだけにする(名前は title で出る)
    const label = text => el("span.vps-btn-label", text);
    $("vps-header-right").append(
        projLabel,
        el("button.vps-btn", {
            title: t("new"),
            onclick: async () => {
                if (!(await confirmDialog(t("new"), t("confirmNew")))) return;
                await studio.newProject();
                loadDefaultModel(studio);
            },
        }, "📄", label(t("new"))),
        el("button.vps-btn", { title: t("open"), onclick: () => openProjectDialog(studio) }, "📂", label(t("open"))),
        el("button.vps-btn", { title: `${t("save")} (Ctrl+S)`, onclick: () => saveProject(studio) }, "💾", label(t("save"))),
        el("button.vps-btn", { title: t("saveAs"), onclick: () => saveProject(studio, { as: true }) }, "🗂", label(t("saveAs"))),
        undoBtn, redoBtn,
        outputSizeControl(studio),
        el("button.vps-btn", { title: t("exportStillTip"), onclick: () => openStillDialog(studio) }, "📸", label(t("exportStill"))),
        el("button.vps-btn.primary", { title: t("exportVideoTip"), onclick: () => openExportDialog(studio) }, `🎬 ${t("export")}`),
        el("button.vps-btn.icon.vps-settings-btn", { title: t("settings"), onclick: () => openSettingsDialog(studio) }, "⚙"),
    );
    const syncName = () => { projLabel.textContent = studio.projectName; document.title = `${studio.projectName} — VRM Pose Studio`; };
    document.addEventListener("vps:project-saved", syncName);
    studio.addEventListener("objects", syncName);
    studio.addEventListener("history", () => { undoBtn.disabled = !studio.canUndo; redoBtn.disabled = !studio.canRedo; });
    syncName();
}

let renders, generate, regional;
function showTab(id) {
    document.querySelectorAll(".vps-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
    document.querySelectorAll(".vps-tab-content").forEach(s => s.classList.toggle("active", s.id === `vps-tab-${id}`));
    if (id === "renders") renders.load();
    if (id === "generate") generate.show();
    if (id === "regional") regional.show();
    try { localStorage.setItem("vps:tab", id); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- viewport toolbar
function buildViewportToolbar(studio, root) {
    const modeBtn = (mode, label, title) => el("button.vps-btn.icon.vps-mode", { dataset: { mode }, title, onclick: () => studio.setTransformMode(mode) }, label);
    const spaceBtn = el("button.vps-btn.small", { title: t("space"), onclick: () => studio.toggleSpace() });
    const jointsBtn = el("button.vps-btn.small.toggle", { title: t("joints"), onclick: () => { studio.setShowAllJoints(!studio.showAllJoints); sync(); } }, `● ${t("joints")}`);
    const fingersBtn = el("button.vps-btn.small.toggle.on", { title: t("fingers"), onclick: () => { studio.setShowFingers(!studio.showFingers); sync(); } }, `✋ ${t("fingers")}`);
    const sizeLabel = el("span.vps-size-label");
    const jointRange = el("input", {
        type: "range", min: 0, max: 100, step: 1, value: Math.round(studio.jointOpacity * 100),
        oninput: () => { studio.setJointOpacity(+jointRange.value / 100); jointPct.textContent = `${jointRange.value}%`; },
    });
    const jointPct = el("span.vps-joint-pct", `${jointRange.value}%`);
    const jointOpacity = el("label.vps-joint-opacity", { title: t("jointOpacityTip") }, el("span", t("jointOpacity")), jointRange, jointPct);
    const monitorBtn = el("button.vps-btn.small.toggle", { title: t("monitorTip"), onclick: () => studio.setMonitor() }, `🖥 ${t("monitor")}`);
    const badge = el("div.vps-monitor-badge", t("monitorBadge"));
    const liBtn = el("button.vps-btn.small.vps-li-btn", { title: t("sendToLiTip"), onclick: () => sendToLiNode(studio, liBtn) }, `📤 ${t("sendToLi")}`);
    const ipBtn = el("button.vps-btn.small.toggle.vps-ip-btn", { title: t("imagePoseTip"), onclick: () => imagePose.toggle() }, `🖼 ${t("imagePoseShort")}`);
    const imagePose = buildImagePosePanel($("vps-ip"), studio, { onToggle: v => ipBtn.classList.toggle("on", v) });
    const bar = el("div.vps-vp-toolbar",
        modeBtn("translate", "✥", t("modeMove")), modeBtn("rotate", "⟳", t("modeRotate")), modeBtn("scale", "⤢", t("modeScale")),
        spaceBtn, jointsBtn, fingersBtn,
        el("button.vps-btn.small", { title: t("resetCamera"), onclick: () => studio.vp.resetCamera() }, "🎥⟲"),
        monitorBtn,
        liBtn,
        ipBtn,
        el("button.vps-btn.small.vps-plib-btn", { title: t("poseLibraryTip"), onclick: () => openPoseLibrary(studio) }, `📚 ${t("poseLibrary")}`),
        jointOpacity,
        sizeLabel,
    );
    root.append(bar, badge);
    const sync = () => {
        bar.querySelectorAll(".vps-mode").forEach(b => b.classList.toggle("on", b.dataset.mode === studio.transformMode));
        spaceBtn.textContent = studio.vp.transform.space === "local" ? "Local" : "World";
        jointsBtn.classList.toggle("on", studio.showAllJoints);
        fingersBtn.classList.toggle("on", studio.showFingers);
        sizeLabel.textContent = `${studio.output.width}×${studio.output.height}`;
        monitorBtn.classList.toggle("on", studio.monitor);
        root.classList.toggle("monitor", studio.monitor);
    };
    studio.addEventListener("monitor", sync);
    studio.addEventListener("selection", sync);
    studio.addEventListener("output", sync);
    sync();
}

// 今のフレームを(書き出しと同じ撮り方・出力サイズで)撮って ComfyUI の input/ にアップロードし、
// ComfyUI 側で選択中のノードの image ウィジェットへ書き込む(Workflow Studio の Send to LI node と同じ)。
// ComfyUI のトップメニューから開いたときだけ window.opener が ComfyUI のタブになる
async function sendToLiNode(studio, btn) {
    // 別オリジンのページから開かれた場合、opener のプロパティを読むだけで SecurityError になる
    let opener = null;
    try { opener = typeof window.opener?.vpsSendImageToSelectedNode === "function" ? window.opener : null; } catch { /* ignore */ }
    if (!opener) {
        toast(t("sendToLiNoOpener"), "error", 6000);
        return;
    }
    btn.disabled = true;
    try {
        const { color } = await captureFrame(studio);
        const form = new FormData();
        // 毎回同じ名前で上書きする(input/ に送るたびにファイルが増えないように)
        form.append("image", new File([color], "vps_studio.png", { type: "image/png" }));
        form.append("subfolder", "vps_send");
        form.append("overwrite", "true");
        const r = await fetch("/upload/image", { method: "POST", body: form });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const filename = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
        opener.vpsSendImageToSelectedNode(filename);
        toast(t("sendToLiDone", { name: filename }), "success");
    } catch (e) {
        toast(`${t("sendToLiFailed")}: ${e.message}`, "error", 8000);
    } finally {
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------- drag & drop / shortcuts
function setupDrop(studio, target) {
    target.addEventListener("dragover", e => { e.preventDefault(); target.classList.add("drag"); });
    target.addEventListener("dragleave", () => target.classList.remove("drag"));
    target.addEventListener("drop", async e => {
        e.preventDefault();
        target.classList.remove("drag");
        for (const f of e.dataTransfer.files) {
            const ext = f.name.toLowerCase().split(".").pop();
            let kind = kindForFile(f.name);
            // ビューポートへ落とした画像はプロップ(画像板)にする。背景は「背景・ライト」から
            if (["png", "jpg", "jpeg", "webp"].includes(ext)) kind = e.shiftKey ? "backgrounds" : "props";
            if (!kind) { toast(`unsupported: ${f.name}`, "error"); continue; }
            try {
                toast(`⬆ ${f.name}`);
                const it = await api.uploadAsset(kind, f);
                if (kind === "models") await addActorFromAsset(studio, it);
                else if (kind === "props") await addPropFromAsset(studio, it);
                else if (kind === "backgrounds") {
                    await studio.setEnv({ background: { mode: ["mp4", "webm", "mov"].includes(ext) ? "video" : "image", url: it.url, name: it.name } });
                    studio.select("scene");
                } else if (kind === "poses") {
                    const a = studio.selectedObject();
                    if (a?.type === "actor") studio.applyPoseJson(a.id, JSON.parse(await f.text()));
                    else toast(t("nothingSelected"), "error");
                } else if (kind === "motions") {
                    const a = studio.selectedObject();
                    if (a?.type === "actor") await importMotion(studio, a, it);
                    else toast(t("nothingSelected"), "error");
                } else if (kind === "audio") {
                    await placeAudio(studio, it);
                }
            } catch (err) {
                toast(`${f.name}: ${err.message}`, "error", 6000);
            }
        }
    });
}

function setupShortcuts(studio, tlUi) {
    document.addEventListener("keydown", e => {
        if (!$("vps-tab-studio").classList.contains("active")) return;
        if (e.target.closest("input, textarea, select, [contenteditable]") || document.querySelector(".vps-modal-overlay")) return;
        const k = e.key.toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && k === "z") { e.preventDefault(); e.shiftKey ? studio.redo() : studio.undo(); return; }
        if (ctrl && k === "y") { e.preventDefault(); studio.redo(); return; }
        if (ctrl && k === "s") { e.preventDefault(); saveProject(studio); return; }
        if (ctrl && k === "d") { e.preventDefault(); const o = studio.selectedObject(); if (o) studio.duplicate(o.id); return; }
        if (ctrl && k === "c") { tlUi.copyKeys(); return; }
        if (ctrl && k === "v") { tlUi.pasteKeys(); return; }
        if (ctrl) return;
        switch (k) {
            case "w": studio.setTransformMode("translate"); break;
            case "e": studio.setTransformMode("rotate"); break;
            case "r": studio.setTransformMode("scale"); break;
            case "q": studio.toggleSpace(); break;
            case "k": studio.keySelected(); break;
            case "m": studio.setMonitor(); break;
            case "b": tlUi.splitAudio(); break;
            case "f": { const o = studio.selectedObject(); if (o) studio.vp.frameObject(o.root); break; }
            case " ": e.preventDefault(); studio.play(); break;
            case "arrowleft": e.preventDefault(); studio.seek(Math.round(studio.timeline.current) - (e.shiftKey ? 10 : 1)); break;
            case "arrowright": e.preventDefault(); studio.seek(Math.round(studio.timeline.current) + (e.shiftKey ? 10 : 1)); break;
            case "home": studio.seek(studio.timeline.playRange()[0]); break;
            case "end": studio.seek(studio.timeline.playRange()[1]); break;
            case "escape": if (tlUi.exitDeleteMode()) break; studio.select(studio.selection?.bone ? studio.selection.id : null); break;
            case "delete": case "backspace": {
                if (tlUi.deleteSelected()) break;
                const o = studio.selectedObject();
                if (o) studio.removeObject(o.id);
                break;
            }
            default: return;
        }
    });
}

// ---------------------------------------------------------------- left panel
// シーン / 音声(A) / 音声 API(S) を切り替える。3D Pose Editor のポーズタブの A・S に相当
function buildLeftPanel(root, studio) {
    const panes = {
        scene: el("div.vps-left-pane"),
        audio: el("div.vps-left-pane"),
        api: el("div.vps-left-pane"),
    };
    buildOutliner(panes.scene, studio);
    const views = { audio: buildAudioPanel(panes.audio, studio), api: buildAudioSettings(panes.api, studio) };
    const tabs = [["scene", t("outliner")], ["audio", `🎵 ${t("audioTab")}`], ["api", `🔧 ${t("audioApiShort")}`]].map(([k, label]) =>
        el("button.vps-left-tab", { dataset: { k }, title: k === "api" ? t("audioApiTab") : "", onclick: () => show(k) }, label));
    const show = k => {
        for (const b of tabs) b.classList.toggle("active", b.dataset.k === k);
        for (const [n, p] of Object.entries(panes)) p.hidden = n !== k;
        views[k]?.show();
    };
    root.append(el("div.vps-left-tabs", tabs), ...Object.values(panes));
    show("scene");
}

// ---------------------------------------------------------------- boot
const studio = new Studio($("vps-viewport"));
applySettings(studio, settings);
window.vpsStudio = studio; // デバッグ用
buildHeader(studio);
buildViewportToolbar(studio, $("vps-viewport-wrap"));
buildLeftPanel($("vps-left"), studio);
buildInspector($("vps-right"), studio);
const tlUi = buildTimeline($("vps-timeline"), studio);
renders = buildRendersTab($("vps-tab-renders"));
generate = buildGenerateTab($("vps-tab-generate"), studio);
regional = buildRegionalTab($("vps-tab-regional"), studio);
buildHelp($("vps-tab-help"));
setupDrop(studio, $("vps-viewport-wrap"));
setupShortcuts(studio, tlUi);

// パネル境界のドラッグで幅・高さを変える
for (const h of document.querySelectorAll(".vps-resizer")) {
    h.addEventListener("pointerdown", e => {
        const prop = h.dataset.prop, dir = +h.dataset.dir;
        const start = h.dataset.axis === "y" ? e.clientY : e.clientX;
        const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(prop));
        h.setPointerCapture(e.pointerId);
        const move = ev => {
            const d = (h.dataset.axis === "y" ? ev.clientY : ev.clientX) - start;
            document.documentElement.style.setProperty(prop, `${Math.max(140, cur + d * dir)}px`);
        };
        const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
    });
}

let lastTab = "studio";
try { lastTab = localStorage.getItem("vps:tab") || "studio"; } catch { /* ignore */ }
showTab(lastTab);

// 前回のプロジェクトを開く(?project=名前 で指定も可)
const want = new URLSearchParams(location.search).get("project") ?? (() => { try { return localStorage.getItem("vps:lastProject"); } catch { return null; } })();
// 前回のプロジェクトが無ければ(開けなければ)既定モデルを追加する
(async () => {
    if (want) {
        try { await loadProjectByName(studio, want); return; } catch {
            // 消えていたら新規扱いにして、次回からは開こうとしない
            try { localStorage.removeItem("vps:lastProject"); } catch { /* ignore */ }
        }
    }
    await loadDefaultModel(studio);
    studio.resetHistory();
})();

window.addEventListener("beforeunload", e => {
    if (studio.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});
