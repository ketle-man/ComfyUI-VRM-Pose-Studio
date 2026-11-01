// VRM Pose Studio — ComfyUI 側の拡張
// ・アクションバーに「Pose Studio を開く」ボタン(Shift+クリックで別ウィンドウ)
// ・Load Studio Render ノードに「Open Studio」「Refresh renders」ボタン
import { app } from "../../scripts/app.js";

const STUDIO_PATH = "/vps";
const TOOLTIP = "Open VRM Pose Studio (Shift+Click: new window)";
const BUTTON_CLASS = "vps-top-menu-button";

// アクションバーの icon は Tailwind のクラス名(icon-[mdi--…])で指定するが、フロントエンドの CSS に
// 含まれているアイコンしか表示されない(未使用のクラスはビルド時に削られる)。そのため SVG を直接差し込む
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<circle cx="12" cy="4.5" r="2.2" fill="currentColor" stroke="none"/>
<path d="M12 8v6.5M12 14.5l-3.5 6M12 14.5l3.5 6M12 10l-5-3M12 10l5-3"/></svg>`;

function openStudio(event) {
    const url = `${window.location.origin}${STUDIO_PATH}`;
    if (event?.shiftKey) window.open(url, "_blank", "width=1600,height=960,resizable=yes");
    else window.open(url, "vrm_pose_studio");
}

function applyIcon(btn) {
    if (btn.querySelector("svg")) return;
    btn.classList.add(BUTTON_CLASS);
    btn.innerHTML = ICON_SVG;
    Object.assign(btn.style, { borderRadius: "4px", padding: "6px" });
    const svg = btn.querySelector("svg");
    svg.style.width = "20px";
    svg.style.height = "20px";
}

function installIcon() {
    const sel = `button[aria-label="${TOOLTIP}"]`;
    // Vue が描画するまで待ってから差し込む
    const poll = (n = 0) => {
        const btns = document.querySelectorAll(sel);
        btns.forEach(applyIcon);
        if (!btns.length && n < 600) requestAnimationFrame(() => poll(n + 1));
    };
    poll();
    // アクションバーが再描画されて <i> に戻されたら差し直す
    new MutationObserver(() => {
        document.querySelectorAll(sel).forEach(b => { if (b.querySelector("i") || !b.querySelector("svg")) applyIcon(b); });
    }).observe(document.body, { childList: true, subtree: true });
}

// レンダー一覧を取り直してコンボの選択肢を更新する(ComfyUI の再読み込み不要)
async function refreshRenders(node) {
    const w = node.widgets?.find(x => x.name === "render");
    if (!w) return;
    try {
        const res = await fetch("/vps/api/renders");
        const names = (await res.json()).items.filter(m => m.frames_saved > 0).map(m => m.name);
        w.options.values = names.length ? names : ["(none)"];
        if (!w.options.values.includes(w.value)) w.value = w.options.values[0];
        app.canvas?.setDirty(true, true);
    } catch (e) {
        console.warn("[VRM Pose Studio] refresh failed", e);
    }
}

// SPA の「LI ノードへ送る」(Workflow Studio の Send to LI node と同じ)から window.opener 経由で呼ばれる。
// アップロード済みのファイル名を、選択中のノードの "image" ウィジェットへ書き込む
// (選択ノードに無ければグラフ内で最初に見つかった "image" ウィジェットを持つノード)
function findImageWidget() {
    const graph = app.graph;
    if (!graph) return null;
    let selected = [];
    try { selected = Object.values(app.canvas?.selected_nodes ?? {}); } catch { /* ignore */ }
    for (const pool of [selected, graph._nodes ?? []]) {
        for (const node of pool) {
            const w = node?.widgets?.find(x => x.name === "image");
            if (w) return w;
        }
    }
    return null;
}

window.vpsSendImageToSelectedNode = (filename) => {
    const w = findImageWidget();
    if (!w) throw new Error("No image widget found (select a LoadImage-type node)");
    if (w.options?.values && !w.options.values.includes(filename)) w.options.values.unshift(filename);
    w.value = filename;
    w.callback?.(w.value);
    app.graph.setDirtyCanvas(true, true);
    return true;
};

app.registerExtension({
    name: "VRMPoseStudio.Menu",
    actionBarButtons: [
        { icon: "icon-[mdi--account] size-4", tooltip: TOOLTIP, onClick: openStudio },
    ],
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VPS_LoadRender") return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onCreated?.apply(this, arguments);
            this.addWidget("button", "🎬 Open Studio", null, () => openStudio());
            this.addWidget("button", "🔄 Refresh renders", null, () => refreshRenders(this));
        };
    },
    async setup() {
        installIcon();
        // SPA から「ComfyUI に送る」を押したとき(localStorage の storage イベントは他タブにだけ届く)
        window.addEventListener("storage", (e) => {
            if (e.key !== "vps:lastRender" || !e.newValue) return;
            const { name } = JSON.parse(e.newValue);
            for (const node of app.graph?._nodes ?? []) {
                if (node.type !== "VPS_LoadRender") continue;
                // 選択肢は全ノードで更新し、値を差し替えるのは選択中のノード(または未設定のノード)だけ
                const w = node.widgets?.find(x => x.name === "render");
                const adopt = !!app.canvas?.selected_nodes?.[node.id] || w?.value === "(none)";
                refreshRenders(node).then(() => {
                    if (adopt && w && w.options.values.includes(name)) { w.value = name; app.canvas?.setDirty(true, true); }
                });
            }
        });
    },
});
