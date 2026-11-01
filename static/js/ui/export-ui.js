// export-ui.js — 書き出しダイアログ / 書き出し一覧タブ / プロジェクトの保存・読込

import { api, blobToDataURL } from "../api.js";
import { t } from "../i18n.js";
import { el, clear, openModal, toast, promptText, confirmDialog, downloadBlob } from "../util.js";
import { exportRender, captureFrame } from "../engine/exporter.js";

const pref = (k, d) => { try { return localStorage.getItem(`vps:export:${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`vps:export:${k}`, v); } catch { /* ignore */ } };
const defaultName = studio => `${studio.projectName}_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1_")}`;

// ================================================================ still dialog
// 現在フレームの静止画。PNG をそのままダウンロードするか、ComfyUI の input/vrm_pose_studio/ へ書き出す(Load Studio Render 用)

export function openStillDialog(studio) {
    const tl = studio.timeline;
    const frame = Math.round(tl.current);
    const name = el("input.vps-input", { value: defaultName(studio) });
    const w = el("input.vps-num", { type: "number", min: 64, max: 8192, step: 8, value: studio.output.width });
    const h = el("input.vps-num", { type: "number", min: 64, max: 8192, step: 8, value: studio.output.height });
    const mask = el("input", { type: "checkbox", checked: pref("stillMask", "1") === "1", onchange: e => setPref("stillMask", e.target.checked ? "1" : "0") });
    const preview = el("img.vps-still-preview", { alt: "" });
    const previewBox = el("div.vps-still-preview-box", preview);
    const status = el("div.vps-hint");
    const cam = studio.cams.get(studio.cams.cutAt(tl, frame));

    // ダウンロードは 1 回に 1 ファイル(続けて落とすとブラウザの「複数ファイルのダウンロード」確認が出るため)
    const downloadBtn = el("button.vps-btn", { onclick: () => run(() => download(false)) }, `⬇ ${t("stillDownload")}`);
    const maskBtn = el("button.vps-btn", { title: t("stillDownloadMaskTip"), onclick: () => run(() => download(true)) }, `⬇ ${t("stillDownloadMask")}`);
    const comfyBtn = el("button.vps-btn.primary", { title: t("sendHint"), onclick: () => run(toComfy) }, `📥 ${t("stillToComfy")}`);
    const buttons = [downloadBtn, maskBtn, comfyBtn];
    const m = openModal(`📸 ${t("exportStill")}`, el("div.vps-form",
        previewBox,
        el("div.vps-hint", `${t("curFrame")} ${frame}${cam ? ` · 🎥 ${cam.name}` : ""}`),
        el("label.vps-field", el("span.vps-label", t("renderName")), name),
        el("label.vps-field", el("span.vps-label", `${t("width")}×${t("height")}`), el("div.vps-vec3", w, h)),
        el("label.vps-check", mask, el("span", t("stillComfyMask"))),
        status,
        el("div.vps-hint", t("stillHint")),
    ), { footer: [el("button.vps-btn", { onclick: () => m.close() }, t("cancel")), ...buttons] });

    // プレビュー(書き出しと同じ撮り方で小さく撮る)
    (async () => {
        const pw = 480, ph = Math.max(1, Math.round((pw * studio.output.height) / studio.output.width));
        try {
            const { color } = await captureFrame(studio, { width: pw, height: ph });
            preview.src = URL.createObjectURL(color);
            preview.onload = () => URL.revokeObjectURL(preview.src);
        } catch (e) { previewBox.remove(); console.warn("[VPS] still preview failed", e); }
    })();

    async function run(fn) {
        buttons.forEach(b => (b.disabled = true));
        status.textContent = `${t("rendering")}…`;
        try {
            // ダウンロードのあとは閉じない(続けてマスクも落とせるように)
            if (await fn() !== "keep") m.close();
            else status.textContent = "";
        } catch (e) {
            toast(`${t("exportFailed")}: ${e.message}`, "error", 8000);
            status.textContent = e.message;
        }
        buttons.forEach(b => (b.disabled = false));
    }

    const base = () => (name.value.trim() || defaultName(studio)).replace(/[\\/:*?"<>|]/g, "_");

    async function download(isMask) {
        const { color, mask: mk } = await captureFrame(studio, { width: +w.value, height: +h.value, mask: isMask, color: !isMask });
        const file = isMask ? `${base()}_mask.png` : `${base()}.png`;
        downloadBlob(isMask ? mk : color, file);
        toast(`${t("downloaded")}: ${file}`, "success");
        return "keep";
    }

    async function toComfy() {
        const info = await exportRender(studio, { name: name.value.trim() || undefined, still: true, width: +w.value, height: +h.value, mask: mask.checked });
        toast(`${t("exportDone")}: ${info.name}`, "success", 5000);
        document.dispatchEvent(new CustomEvent("vps:renders-changed", { detail: info }));
    }
}

// ================================================================ export dialog (動画)

export function openExportDialog(studio) {
    const tl = studio.timeline;
    const [rs, re] = tl.playRange();
    const name = el("input.vps-input", { value: defaultName(studio) });
    const mode = el("select.vps-select", {},
        el("option", { value: "video" }, t("video")),
        el("option", { value: "videoOnly" }, t("videoOnly")));
    const start = el("input.vps-num", { type: "number", min: 0, value: rs });
    const end = el("input.vps-num", { type: "number", min: 0, value: Math.max(rs, re - 1) });
    const fps = el("input.vps-num", { type: "number", min: 1, max: 120, value: tl.fps });
    const w = el("input.vps-num", { type: "number", min: 64, max: 8192, step: 8, value: studio.output.width });
    const h = el("input.vps-num", { type: "number", min: 64, max: 8192, step: 8, value: studio.output.height });
    const mask = el("input", { type: "checkbox", checked: true });
    const hasAudio = studio.audios.some(c => !c.muted);
    const audio = el("input", { type: "checkbox", checked: hasAudio, disabled: !hasAudio });
    const bar = el("div.vps-progress-bar", el("div.vps-progress-fill"));
    const status = el("div.vps-hint");
    // OUTPUT(3D Pose Editor と同じ): 作る形式と、ComfyUI の output へ保存するか(オフならブラウザでダウンロード)
    const fmtChecks = Object.fromEntries(["webm", "mp4", "gif"].map(f => [f, el("input", {
        type: "checkbox", checked: pref(`fmt_${f}`, f === "mp4" ? "1" : "0") === "1",
        onchange: e => setPref(`fmt_${f}`, e.target.checked ? "1" : "0"),
    })]));
    const saveOut = el("input", { type: "checkbox", checked: pref("saveOutput", "0") === "1", onchange: e => setPref("saveOutput", e.target.checked ? "1" : "0") });
    const outputRows = el("div.vps-form-group.vps-export-output",
        el("div.vps-label", "OUTPUT"),
        el("div.vps-btn-row",
            el("label.vps-check", { title: t("fmtWebmTip") }, fmtChecks.webm, el("span", "🎬 WebM")),
            el("label.vps-check", { title: t("fmtMp4Tip") }, fmtChecks.mp4, el("span", "🎥 MP4")),
            el("label.vps-check", { title: t("fmtGifTip") }, fmtChecks.gif, el("span", "🎞 GIF")),
        ),
        el("label.vps-check", { title: t("saveOutputTip") }, saveOut, el("span", "Save to ComfyUI output")),
        el("div.vps-hint", t("outputHint")),
    );
    const videoRows = el("div.vps-form-group",
        el("label.vps-field", el("span.vps-label", `${t("start")} / ${t("end")}`), el("div.vps-vec3", start, end)),
        el("label.vps-field", el("span.vps-label", t("fps")), fps),
        el("label.vps-check", audio, el("span", t("withAudio"))),
        outputRows,
    );
    // 動画のみ: 連番 PNG を残さないのでマスクは作れない。前回の選択を覚えておく
    if (pref("mode", "video") === "videoOnly") mode.value = "videoOnly";
    const syncMode = () => {
        const only = mode.value === "videoOnly";
        mask.disabled = only;
        if (only) mask.checked = false;
        setPref("mode", mode.value);
    };
    mode.addEventListener("change", syncMode);
    syncMode();

    let ctrl = null;
    const startBtn = el("button.vps-btn.primary", { onclick: run }, t("startExport"));
    const cancelBtn = el("button.vps-btn", { onclick: () => (ctrl ? ctrl.abort() : m.close()) }, t("cancel"));
    const m = openModal(`🎬 ${t("exportTitle")}`, el("div.vps-form",
        el("label.vps-field", el("span.vps-label", t("renderName")), name),
        el("label.vps-field", el("span.vps-label", ""), mode),
        videoRows,
        el("label.vps-field", el("span.vps-label", `${t("width")}×${t("height")}`), el("div.vps-vec3", w, h)),
        el("label.vps-check", mask, el("span", t("mask"))),
        bar, status,
        el("div.vps-hint", t("sendHint")),
    ), { footer: [cancelBtn, startBtn], onClose: () => ctrl?.abort() });

    async function run() {
        ctrl = new AbortController();
        startBtn.disabled = true;
        const videoOnly = mode.value === "videoOnly";
        const formats = ["webm", "mp4", "gif"].filter(f => fmtChecks[f].checked);
        if (videoOnly && !formats.length) {
            startBtn.disabled = false;
            status.textContent = t("videoOnlyNeedsFormat");
            return;
        }
        try {
            const info = await exportRender(studio, {
                name: name.value.trim() || undefined,
                start: Math.max(0, +start.value), end: Math.max(+start.value, +end.value),
                fps: +fps.value || tl.fps,
                width: +w.value, height: +h.value,
                mask: mask.checked && !videoOnly,
                withAudio: audio.checked,
                formats,
                keepFrames: !videoOnly,
                saveOutput: saveOut.checked,
            }, {
                signal: ctrl.signal,
                onProgress: p => {
                    bar.firstChild.style.width = `${(p.done / p.total) * 100}%`;
                    status.textContent = p.phase === "encode" ? `${t("encoding")}…` : `${t("rendering")} ${p.done}/${p.total}`;
                },
            });
            ctrl = null;
            if (info.video_error) toast(info.video_error.slice(0, 240), "error", 8000);
            if (info.outputs?.length) {
                toast(`${t("savedToOutput")}: ${info.outputs.map(o => `output/${o.subfolder}/${o.filename}`).join(", ")}`, "success", 8000);
            } else {
                // 「Save to ComfyUI output」がオフなら、作った形式をブラウザでダウンロードする
                for (const [f, url] of Object.entries(info.videos ?? {})) {
                    const a = el("a", { href: url, download: `${info.name}.${f}` });
                    document.body.append(a); a.click(); a.remove();
                }
            }
            if (!info.video_error) toast(`${t("exportDone")}: ${info.name}`, "success", 5000);
            m.close();
            document.dispatchEvent(new CustomEvent("vps:renders-changed", { detail: info }));
        } catch (e) {
            ctrl = null;
            startBtn.disabled = false;
            if (e.name !== "AbortError") toast(`${t("exportFailed")}: ${e.message}`, "error", 8000);
            status.textContent = e.name === "AbortError" ? t("cancel") : e.message;
        }
    }
}

// ================================================================ renders tab

export function buildRendersTab(root) {
    const grid = el("div.vps-render-grid");
    root.append(
        el("div.vps-renders-head",
            el("h2", t("tabRenders")),
            el("button.vps-btn", { onclick: () => load() }, "🔄"),
            el("span.vps-hint", t("sendHint")),
        ),
        grid,
    );

    async function load() {
        clear(grid);
        let items = [];
        try { items = await api.listRenders(); } catch (e) { toast(e.message, "error"); }
        if (!items.length) grid.append(el("div.vps-empty", t("rendersEmpty")));
        for (const it of items) {
            const gif = it.videos?.gif;
            const media = it.video
                ? el("video", { src: it.video, controls: true, muted: true, loop: true, preload: "metadata", poster: it.thumb ?? undefined })
                : gif ? el("img", { src: gif, loading: "lazy" })
                : it.thumb ? el("img", { src: it.thumb, loading: "lazy" }) : el("div.vps-asset-icon", "—");
            grid.append(el("div.vps-render-card",
                el("div.vps-render-media", media),
                el("div.vps-render-info",
                    el("div.vps-render-name", it.name),
                    el("div.vps-hint", `${it.width}×${it.height} · ${it.video_only ? `${it.frames} ${t("framesCount")} · ${t("videoOnlyShort")}` : `${it.frames_saved} ${t("framesCount")}`} · ${it.fps} fps${it.mask ? " · mask" : ""}`),
                    it.video_error ? el("div.vps-error", it.video_error.slice(0, 160)) : null,
                    el("div.vps-btn-row",
                        el("button.vps-btn.small", { onclick: () => { navigator.clipboard?.writeText(it.name); toast(it.name); } }, `📋 ${t("copyName")}`),
                        it.thumb ? el("a.vps-btn.small", { href: it.thumb, target: "_blank" }, `🖼 PNG`) : null,
                        ...Object.entries(it.videos ?? {}).map(([f, url]) => el("a.vps-btn.small", { href: url, download: `${it.name}.${f}` }, `⬇ ${f.toUpperCase()}`)),
                        el("button.vps-btn.small.danger", {
                            onclick: async () => {
                                if (!(await confirmDialog(t("delete"), `${it.name} — ${t("confirmDelete")}`, { danger: true, okLabel: t("delete") }))) return;
                                await api.deleteRender(it.name);
                                load();
                            },
                        }, "🗑"),
                    ),
                ),
            ));
        }
    }
    document.addEventListener("vps:renders-changed", load);
    return { load };
}

// ================================================================ projects

export async function saveProject(studio, { as = false } = {}) {
    let name = studio.projectName;
    if (as || !name || name === "untitled") {
        name = await promptText(t("projectName"), name === "untitled" ? "" : name, { okLabel: t("save") });
        if (!name) return false;
    }
    studio.projectName = name;
    const project = studio.serialize();
    let thumb = null;
    try { thumb = await blobToDataURL(await studio.thumbnail(320)); } catch { /* サムネイルは無くてもよい */ }
    await api.saveProject(name, project, thumb);
    studio.markSaved();
    try { localStorage.setItem("vps:lastProject", name); } catch { /* ignore */ }
    toast(`${t("saved")}: ${name}`, "success");
    document.dispatchEvent(new CustomEvent("vps:project-saved", { detail: name }));
    return true;
}

export async function loadProjectByName(studio, name) {
    toast(`${t("loading")} ${name}`);
    const project = await api.getProject(name);
    const { failed } = await studio.load(typeof project === "string" ? JSON.parse(project) : project);
    studio.projectName = name;
    studio.resetHistory();
    try { localStorage.setItem("vps:lastProject", name); } catch { /* ignore */ }
    if (failed.length) toast(`${t("loadFailed")}: ${failed.join(", ")}`, "error", 8000);
    else toast(`${t("loaded")}: ${name}`, "success");
    document.dispatchEvent(new CustomEvent("vps:project-saved", { detail: name }));
}

export function openProjectDialog(studio) {
    const grid = el("div.vps-asset-grid");
    const m = openModal(t("projects"), grid, { wide: true });
    (async () => {
        const items = await api.listProjects().catch(() => []);
        if (!items.length) grid.append(el("div.vps-empty", t("empty")));
        for (const it of items) {
            grid.append(el("div.vps-asset-card", {
                onclick: async () => { m.close(); try { await loadProjectByName(studio, it.name); } catch (e) { toast(`${t("loadFailed")}: ${e.message}`, "error"); } },
            },
                el("div.vps-asset-thumb", it.thumb ? el("img", { src: it.thumb }) : el("div.vps-asset-icon", "🎬")),
                el("div.vps-asset-name", it.name),
                el("div.vps-asset-meta", new Date(it.mtime * 1000).toLocaleString()),
                el("button.vps-icon-btn.vps-asset-del", {
                    title: t("delete"),
                    onclick: async e => {
                        e.stopPropagation();
                        if (!(await confirmDialog(t("delete"), `${it.name} — ${t("confirmDelete")}`, { danger: true, okLabel: t("delete") }))) return;
                        await api.deleteProject(it.name);
                        e.target.closest(".vps-asset-card").remove();
                    },
                }, "🗑"),
            ));
        }
    })();
}
