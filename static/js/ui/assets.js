// assets.js — アセット選択ダイアログ(一覧・アップロード・削除)

import { api } from "../api.js";
import { t } from "../i18n.js";
import { el, clear, openModal, toast, fmtBytes, confirmDialog } from "../util.js";

const ACCEPT = {
    models: ".vrm",
    props: ".glb,.gltf,.vrm,.png,.jpg,.jpeg,.webp",
    backgrounds: ".png,.jpg,.jpeg,.webp,.mp4,.webm,.mov",
    poses: ".json,.vroidpose",
    audio: ".wav,.mp3,.ogg,.m4a,.flac",
    motions: ".vrma,.bvh,.fbx",
};
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];
const VIDEO_EXT = [".mp4", ".webm", ".mov"];

// 選んだアセット({name,url,source,path,ext}) を返す。キャンセルで null
// filter(item) で表示を絞れる(例: 画像板は画像だけ)
export function pickAsset(kind, { title, filter } = {}) {
    return new Promise(resolve => {
        let done = false;
        const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
        const grid = el("div.vps-asset-grid");
        const search = el("input.vps-input", { type: "search", placeholder: t("search") });
        const progress = el("div.vps-upload-progress");
        let items = [];

        const render = () => {
            clear(grid);
            const q = search.value.trim().toLowerCase();
            const shown = items.filter(i => (!filter || filter(i)) && (!q || i.path.toLowerCase().includes(q)));
            if (!shown.length) grid.append(el("div.vps-empty", t("empty")));
            for (const it of shown) {
                let preview;
                if (IMAGE_EXT.includes(it.ext)) preview = el("img", { src: it.url, loading: "lazy" });
                else if (VIDEO_EXT.includes(it.ext)) preview = el("video", { src: `${it.url}#t=0.5`, muted: true, preload: "metadata" });
                else preview = el("div.vps-asset-icon", it.ext.replace(".", "").toUpperCase());
                const card = el("div.vps-asset-card", { title: it.path, onclick: () => finish(it) },
                    el("div.vps-asset-thumb", preview),
                    el("div.vps-asset-name", it.name),
                    el("div.vps-asset-meta", `${it.source === "local" ? "" : `[${it.source}] `}${fmtBytes(it.size)}`),
                    it.source === "local" ? el("button.vps-icon-btn.vps-asset-del", {
                        title: t("delete"),
                        onclick: async e => {
                            e.stopPropagation();
                            if (!(await confirmDialog(t("delete"), `${it.name} — ${t("confirmDelete")}`, { danger: true, okLabel: t("delete") }))) return;
                            await api.deleteAsset(kind, it.path);
                            load();
                        },
                    }, "🗑") : null,
                );
                grid.append(card);
            }
        };
        const load = async () => {
            try { items = await api.listAssets(kind); } catch (e) { toast(e.message, "error"); items = []; }
            render();
        };
        const upload = async files => {
            for (const f of files) {
                try {
                    progress.textContent = `${f.name} 0%`;
                    const it = await api.uploadAsset(kind, f, p => (progress.textContent = `${f.name} ${Math.round(p * 100)}%`));
                    progress.textContent = "";
                    if (files.length === 1) { finish(it); return; }
                } catch (e) {
                    progress.textContent = "";
                    toast(`${f.name}: ${e.message}`, "error");
                }
            }
            load();
        };
        const fileInput = el("input", { type: "file", accept: ACCEPT[kind], multiple: true, style: { display: "none" }, onchange: () => upload([...fileInput.files]) });
        const head = el("div.vps-asset-head", search,
            el("button.vps-btn.primary", { onclick: () => fileInput.click() }, `⬆ ${t("upload")}`), fileInput, progress);
        const body = el("div.vps-asset-body", head, grid, el("div.vps-hint", t("dropHere")));
        body.addEventListener("dragover", e => { e.preventDefault(); body.classList.add("drag"); });
        body.addEventListener("dragleave", () => body.classList.remove("drag"));
        body.addEventListener("drop", e => { e.preventDefault(); body.classList.remove("drag"); upload([...e.dataTransfer.files]); });
        search.addEventListener("input", render);
        const m = openModal(title ?? t("assets"), body, { wide: true, onClose: () => finish(null) });
        load();
    });
}

export async function uploadFile(kind, file) {
    return api.uploadAsset(kind, file);
}
