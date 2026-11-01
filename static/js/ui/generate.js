// generate.js — 「生成」タブ: スタジオの書き出しを ComfyUI のワークフローに渡して実行する
//
// ・ワークフローは ComfyUI に保存したもの(user/<user>/workflows)、同梱のサンプル(example_workflows/)か JSON ファイル。UI 形式は
//   Workflow Studio の変換(lib/comfyui-workflow.js)で API 形式にしてから投入する
// ・Load Studio Render (VPS) ノードは、選んだ書き出しに自動で差し替える
// ・LoadImage ノードは「そのまま / 書き出し画像 / マスク」を選べる(input/vrm_pose_studio/<名前>/ を直接参照)
// ・3D Pose Editor の PoseEditor3D ノードは image_data(base64)に書き出しの画像を入れる(既存のワークフローをそのまま使える)
// ・テキスト入力(プロンプト等)はここで書き換えられ、シードは毎回ランダムにできる
// ・BV Node Pack の BV Regional Prompt ノードには、リージョンタブの設定(bv.regional 文書)を入れられる
// ・結果(画像・動画)は背景・プロップとしてスタジオに取り込める

import { api, blobToDataURL } from "../api.js";
import { t } from "../i18n.js";
import { el, clear, toast, pickFile } from "../util.js";
import { comfyWorkflow } from "../lib/comfyui-workflow.js";
import { exportRender } from "../engine/exporter.js";
import { addPropFromAsset } from "./outliner.js";
import { queuePrompt, waitPrompt, interruptPrompt, viewUrl } from "./comfy-run.js";
import { regionalDocument } from "./regional.js";

const LS_KEY = "vps:generate";
const RENDER_DIR = "vrm_pose_studio";
const IMAGE_LOADERS = ["LoadImage", "LoadImageMask"];
const SAMPLE_PREFIX = "📦 sample/";
const TEXT_KEYS = /^(text|prompt|positive|negative|text_[gl]|string|value)$/i;

function loadPrefs() { try { return JSON.parse(localStorage.getItem(LS_KEY)) ?? {}; } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

export function buildGenerateTab(root, studio) {
    const prefs = loadPrefs();
    let apiBase = null;      // 変換済みの API 形式(元)
    let wfName = "";
    let running = null;      // { promptId }

    // ---------------------------------------------------------------- 左: 設定
    const wfSearch = el("input.vps-input", { type: "search", placeholder: t("search") });
    const wfSel = el("select.vps-select.vps-gen-wflist", { size: 10 });
    const wfInfo = el("div.vps-hint");
    const renderSel = el("select.vps-select");
    const bindBox = el("div.vps-gen-binds");
    const textBox = el("div.vps-gen-texts");
    const seedChk = el("input", { type: "checkbox", checked: prefs.randomSeed ?? true, onchange: () => { prefs.randomSeed = seedChk.checked; savePrefs(prefs); } });
    const status = el("div.vps-ip-status");
    const setStatus = (msg, kind = "") => { status.textContent = msg; status.className = `vps-ip-status ${kind}`; };
    const runBtn = el("button.vps-btn.primary", { onclick: () => run() }, `▶ ${t("genRun")}`);
    const exportRunBtn = el("button.vps-btn", { onclick: () => exportAndRun() }, `📸 ${t("genExportRun")}`);
    const stopBtn = el("button.vps-btn.danger", { disabled: true, onclick: () => interrupt() }, `■ ${t("genStop")}`);

    let wfFiles = [];
    const fillWfList = () => {
        const q = wfSearch.value.trim().toLowerCase();
        wfSel.replaceChildren(...wfFiles.filter(f => !q || f.toLowerCase().includes(q)).map(f => el("option", { value: f, selected: f === prefs.workflow }, f)));
    };
    async function loadWfList() {
        try {
            const list = await (await fetch("/api/userdata?dir=workflows&recurse=true")).json();
            wfFiles = list.filter(f => f.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
        } catch (e) { wfFiles = []; setStatus(`${t("ipNoComfy")}: ${e.message}`, "error"); }
        // 同梱のサンプル(example_workflows/)は先頭に SAMPLE_PREFIX 付きで並べる
        try {
            const { items } = await (await fetch("/vps/api/workflows")).json();
            wfFiles = [...items.map(f => SAMPLE_PREFIX + f), ...wfFiles];
        } catch { /* ignore */ }
        fillWfList();
    }
    wfSearch.addEventListener("input", fillWfList);
    wfSel.addEventListener("change", () => openWorkflow(wfSel.value));

    async function openWorkflow(path) {
        if (!path) return;
        try {
            const res = path.startsWith(SAMPLE_PREFIX)
                ? await fetch(`/vps/api/workflows/${encodeURIComponent(path.slice(SAMPLE_PREFIX.length))}`)
                : await fetch(`/api/userdata/${encodeURIComponent(`workflows/${path}`)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await useWorkflow(await res.json(), path);
            prefs.workflow = path;
            savePrefs(prefs);
        } catch (e) { setStatus(`${t("loadFailed")}: ${e.message}`, "error"); }
    }

    async function useWorkflow(wf, name) {
        setStatus(t("loading"));
        const fmt = comfyWorkflow.detectFormat(wf, name);
        if (fmt === "ui") apiBase = await comfyWorkflow.convertUiToApi(wf);
        else if (fmt === "api") apiBase = structuredClone(wf);
        else throw new Error(t("genBadFormat"));
        wfName = name;
        // UI 形式のノードのタイトルを API 側の表示に使う
        const titles = {};
        for (const n of wf.nodes ?? []) if (n.title) titles[n.id] = n.title;
        for (const [id, n] of Object.entries(apiBase)) n._meta ??= { title: titles[id] ?? n.class_type };
        buildBindings();
        const bypassed = comfyWorkflow.getLastBypassedNodes?.().length ?? 0;
        wfInfo.textContent = `${name} · ${Object.keys(apiBase).length} nodes${bypassed ? ` · bypass ${bypassed}` : ""}`;
        setStatus(t("genReady"));
        refreshButtons();
    }

    // ---- ノードの割り当て・テキスト ----
    let binds = {};   // nodeId → "keep" | "frame" | "mask"
    let texts = {};   // `${nodeId}.${input}` → string
    function buildBindings() {
        clear(bindBox); clear(textBox);
        binds = {}; texts = {};
        const saved = prefs.binds?.[wfName] ?? {};
        for (const [id, n] of Object.entries(apiBase)) {
            const title = `#${id} ${n._meta?.title ?? n.class_type}`;
            if (n.class_type === "VPS_LoadRender") {
                binds[id] = "render";
                bindBox.append(el("div.vps-gen-bind", el("span.vps-gen-node", title), el("span.vps-hint", `← ${t("genAuto")}`)));
            } else if (n.class_type === "BV Regional Prompt") {
                binds[id] = saved[id] ?? "regional";
                const sel = el("select.vps-select.small", {
                    onchange: () => { binds[id] = sel.value; (prefs.binds ??= {})[wfName] = { ...binds }; savePrefs(prefs); },
                }, [["keep", t("genKeep")], ["regional", t("genUseRegional")]].map(([v, l]) => el("option", { value: v, selected: v === binds[id] }, l)));
                bindBox.append(el("div.vps-gen-bind", el("span.vps-gen-node", title), sel));
            } else if ((IMAGE_LOADERS.includes(n.class_type) && typeof n.inputs?.image === "string")
                || (n.class_type === "PoseEditor3D" && typeof n.inputs?.image_data === "string")) {
                const isPE = n.class_type === "PoseEditor3D";
                binds[id] = saved[id] ?? (isPE ? "frame" : "keep");
                const sel = el("select.vps-select.small", {
                    onchange: () => { binds[id] = sel.value; (prefs.binds ??= {})[wfName] = { ...binds }; savePrefs(prefs); },
                }, [["keep", isPE ? t("genKeep") : `${t("genKeep")} (${n.inputs.image})`], ["frame", t("genUseFrame")], ["mask", t("genUseMask")]]
                    .map(([v, l]) => el("option", { value: v, selected: v === binds[id] }, l)));
                bindBox.append(el("div.vps-gen-bind", el("span.vps-gen-node", title), sel));
            }
            for (const [k, v] of Object.entries(n.inputs ?? {})) {
                if (typeof v !== "string" || !TEXT_KEYS.test(k) || IMAGE_LOADERS.includes(n.class_type) || n.class_type === "BV Regional Prompt") continue;
                const key = `${id}.${k}`;
                texts[key] = v;
                const ta = el("textarea.vps-input.vps-textarea", { rows: 3, oninput: () => (texts[key] = ta.value) });
                ta.value = v;
                textBox.append(el("div.vps-gen-text", el("div.vps-gen-node", `${title} · ${k}`), ta));
            }
        }
        if (!bindBox.childElementCount) bindBox.append(el("div.vps-hint", t("genNoBind")));
        if (!textBox.childElementCount) textBox.append(el("div.vps-hint", "—"));
    }

    // ---- 書き出しの一覧 ----
    async function loadRenders(select) {
        const items = (await api.listRenders().catch(() => [])).filter(r => r.frames_saved > 0);
        renderSel.replaceChildren(...items.map(r => el("option", { value: r.name }, `${r.name}  (${r.width}×${r.height}, ${r.frames_saved}f${r.mask ? ", mask" : ""})`)));
        if (select && items.some(r => r.name === select)) renderSel.value = select;
        refreshButtons();
    }

    const refreshButtons = () => {
        runBtn.disabled = !!running || !apiBase;
        exportRunBtn.disabled = !!running || !apiBase;
        stopBtn.disabled = !running;
    };

    // ---------------------------------------------------------------- 実行
    async function buildPrompt(renderName) {
        const p = structuredClone(apiBase);
        for (const [id, mode] of Object.entries(binds)) {
            const n = p[id];
            if (mode === "keep") continue;
            if (mode === "regional") { n.inputs.regional_json = JSON.stringify(await regionalDocument(studio)); continue; }
            if (!renderName) throw new Error(t("genNeedRender"));
            const file = `${mode === "mask" ? "mask" : "frame"}_00000.png`;
            if (mode === "render") n.inputs.render = renderName;
            else if (n.class_type === "PoseEditor3D") {
                // マスク(背景が透明な PNG)を渡すと、ノード側でアルファからマスクも作られる
                const res = await fetch(`/vps/api/renders/${encodeURIComponent(renderName)}/file/${file}`);
                if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
                n.inputs.image_data = await blobToDataURL(await res.blob());
            } else n.inputs.image = `${RENDER_DIR}/${renderName}/${file}`;
        }
        for (const [key, v] of Object.entries(texts)) {
            const i = key.indexOf(".");
            p[key.slice(0, i)].inputs[key.slice(i + 1)] = v;
        }
        if (seedChk.checked) comfyWorkflow.applyRandomSeeds(p);
        for (const n of Object.values(p)) delete n._meta;
        return p;
    }

    async function run(renderName = renderSel.value) {
        let prompt;
        try { prompt = await buildPrompt(renderName); } catch (e) { setStatus(e.message, "error"); return; }
        try {
            running = { promptId: await queuePrompt(prompt) };
            refreshButtons();
            const { files, sec } = await waitPrompt(running.promptId, msg => setStatus(msg));
            addResults(files);
            setStatus(`${t("genDone")} · ${files.length} · ${sec}s`, "ok");
        } catch (e) {
            setStatus(e.message, "error");
        } finally {
            running = null;
            refreshButtons();
        }
    }

    async function interrupt() {
        await interruptPrompt(running?.promptId);
        setStatus(t("ipAborted"));
    }

    // 今のフレームを静止画で書き出してから実行
    async function exportAndRun() {
        if (!apiBase) return;
        running = { promptId: null };
        refreshButtons();
        try {
            setStatus(t("rendering"));
            const info = await exportRender(studio, { still: true, mask: true, name: `${studio.projectName}_gen` });
            await loadRenders(info.name);
            running = null;
            await run(info.name);
        } catch (e) {
            setStatus(e.message, "error");
        } finally {
            running = null;
            refreshButtons();
        }
    }

    // ---------------------------------------------------------------- 右: 結果
    const results = el("div.vps-gen-results");

    async function importResult(f, kind) {
        try {
            const blob = await (await fetch(viewUrl(f))).blob();
            const it = await api.uploadAsset(kind, new File([blob], f.filename, { type: blob.type }));
            if (kind === "props") await addPropFromAsset(studio, it);
            else {
                const isVideo = /\.(mp4|webm|mov)$/i.test(f.filename);
                await studio.setEnv({ background: { mode: isVideo ? "video" : "image", url: it.url, name: it.name } });
            }
            toast(`${f.filename} → ${kind === "props" ? t("addProp") : t("background")}`, "success");
        } catch (e) { toast(e.message, "error"); }
    }

    function addResults(files) {
        results.querySelector(".vps-empty")?.remove();
        for (const f of files.reverse()) {
            const url = viewUrl(f);
            const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(f.filename);
            const media = isVideo ? el("video", { src: url, controls: true, loop: true, muted: true }) : el("img", { src: url, loading: "lazy" });
            results.prepend(el("div.vps-render-card",
                el("div.vps-render-media", el("a", { href: url, target: "_blank" }, media)),
                el("div.vps-render-info",
                    el("div.vps-render-name", f.filename),
                    el("div.vps-btn-row",
                        el("button.vps-btn.small", { onclick: () => importResult(f, "backgrounds") }, `🌄 ${t("genToBg")}`),
                        isVideo ? null : el("button.vps-btn.small", { onclick: () => importResult(f, "props") }, `🖼 ${t("genToProp")}`),
                        el("a.vps-btn.small", { href: url, download: f.filename }, "⬇"),
                    ),
                ),
            ));
        }
    }
    results.append(el("div.vps-empty", t("genNoResults")));

    root.append(
        el("div.vps-gen",
            el("div.vps-gen-left",
                el("h4.vps-settings-h", `① ${t("genWorkflow")}`),
                el("div.vps-btn-row", wfSearch,
                    el("button.vps-btn.small", { title: t("refresh"), onclick: loadWfList }, "↺"),
                    el("button.vps-btn.small", {
                        onclick: async () => {
                            const [f] = await pickFile(".json");
                            if (!f) return;
                            try { await useWorkflow(JSON.parse(await f.text()), f.name); } catch (e) { setStatus(e.message, "error"); }
                        },
                    }, `📁 ${t("genFromFile")}`)),
                wfSel, wfInfo,
                el("h4.vps-settings-h", `② ${t("genSource")}`),
                el("div.vps-btn-row", renderSel, el("button.vps-btn.small", { title: t("refresh"), onclick: () => loadRenders(renderSel.value) }, "↺")),
                bindBox,
                el("h4.vps-settings-h", `③ ${t("genTexts")}`),
                textBox,
                el("label.vps-check", seedChk, el("span", t("genRandomSeed"))),
                el("div.vps-btn-row", runBtn, exportRunBtn, stopBtn),
                status,
                el("div.vps-hint", t("genHint")),
            ),
            el("div.vps-gen-right", el("h4.vps-settings-h", t("genResults")), results),
        ),
    );

    document.addEventListener("vps:renders-changed", e => loadRenders(e.detail?.name));
    return {
        async show() {
            if (!wfFiles.length) {
                await loadWfList();
                if (prefs.workflow && wfFiles.includes(prefs.workflow) && !apiBase) openWorkflow(prefs.workflow);
            }
            loadRenders(renderSel.value);
        },
    };
}
