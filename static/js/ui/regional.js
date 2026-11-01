// regional.js — 「リージョン」タブ: シーンの物から領域・マスクを作り、それぞれにプロンプトを付けて生成する
//
// ・人物・プロップのシルエットを本番カメラから 1 体ずつ撮り(studio.captureObjectMasks)、リージョンにする。
//   形式は「マスク」(シルエット)と「領域」(外接矩形)を全体で切り替えられ、リージョンごとにも上書きできる
// ・リージョンはレイヤー(上 = 手前)。重なった所は手前が優先で、「前面を優先」なら奥のリージョンから差し引く
// ・送信形式は BV Node Pack の bv.regional v2 文書(geometry は rect / raster_mask、priority = レイヤー順)
// ・生成は内蔵のワークフロー(Anima + BV Regional Anima Conditioning + Anima LLLite、またはチェックポイント + BV Native)か、
//   生成タブで BV Regional Prompt ノードを含むワークフローに文書を渡す(regionalDocument)
// ・リージョンとプロンプトはプロジェクト(studio.regional)に、モデル・サンプラー設定はこのブラウザに保存する

import { api } from "../api.js";
import { t } from "../i18n.js";
import { el, clear, toast } from "../util.js";
import { addPropFromAsset } from "./outliner.js";
import { queuePrompt, waitPrompt, interruptPrompt, viewUrl } from "./comfy-run.js";

const LS_KEY = "vps:regional";
const LS_TAB = "vps:regional-subtab";
const PALETTE = ["#E45756", "#4C78A8", "#54A24B", "#F58518", "#B279A2", "#72B7B2", "#EECA3B", "#FF9DA6", "#9D755D", "#BAB0AC"];
const BV_NODES = ["BV Regional Prompt", "BV Regional Anima Conditioning", "BV Regional Anima LLLite", "BV Regional Native Conditioning"];
const MIN_RECT = 0.01;      // これより小さいドラッグは枠にしない(正規化座標)
const HANDLE_PX = 7;

const SAMPLER_PRESETS = {
    anima: { steps: 30, cfg: 4, sampler: "er_sde", scheduler: "simple", lora: "", loraStrength: 1 },
    turbo: { steps: 12, cfg: 1, sampler: "er_sde", scheduler: "simple", lora: "anima\\anima-turbo-lora-v0.2.safetensors", loraStrength: 1 },
};
const DEFAULT_GEN = {
    backend: "anima",           // anima | checkpoint
    unet: "", clip: "", vae: "", ckpt: "", lora: "", loraStrength: 1,
    // Anima の条件づけ: native(BV Regional Native Conditioning) | attention(BV Regional Anima Conditioning)。
    // attention は BV Node Pack 1.4.4 が ComfyUI 0.43 の preferred_attention 引数に未対応で KSampler が落ちるため、既定は native
    method: "native",
    composition: "blend",       // native のとき: blend | exclusive | hybrid
    lllite: true, lllitePatch: "", lllitePatchStrength: 1, llliteEnd: 1,
    attnEnd: 0.35,
    steps: 30, cfg: 4, sampler: "er_sde", scheduler: "simple",
    img2img: false, denoise: 0.75,
    randomSeed: true, seed: 0,
};

const uuid = () => crypto.randomUUID();
const clamp01 = v => Math.min(1, Math.max(0, v));

export function defaultRegional() {
    return {
        docId: uuid(),
        global: { pos: "masterpiece, best quality, score_7, safe", neg: "worst quality, low quality, blurry, bad anatomy, bad hands, text, watermark" },
        background: { pos: "", neg: "" },
        mode: "mask",           // 全体の形式: mask | rect
        occlude: true,          // 重なりは手前を優先し、奥のリージョンから差し引く
        feather: 0.01,          // 縁のぼかし(短辺に対する比)
        padding: 0.02,          // 領域(矩形)をシルエットの外へ広げる量(正規化)
        regions: [],            // 先頭 = 手前。{ id, geomId, name, objectId, color, enabled, mode(""=全体に従う|rect|mask), prompt, negative, strength, rect, rectEdited }
    };
}

// ---------------------------------------------------------------- 実行時の情報(保存しない)
const RT = {
    w: 0, h: 0,                 // 撮影したサイズ(= 生成サイズ)
    masks: new Map(),           // objectId → { alpha, bbox, depth }
    ref: null,                  // 参照画像 { img, url, blob }
    eff: new Map(),             // regionId → { alpha, bbox(px) } 重なりを処理した実際の形
    stale: true,                // シーンが変わったので撮り直しが必要
};

function genSize(studio) {
    const r16 = v => Math.max(64, Math.round(v / 16) * 16);
    return { w: r16(studio.output.width), h: r16(studio.output.height) };
}

function state(studio) {
    if (!studio.regional) studio.regional = defaultRegional();
    const R = studio.regional;
    const d = defaultRegional();
    for (const k of Object.keys(d)) R[k] ??= d[k];
    return R;
}

const hasMask = r => !!(r.objectId && RT.masks.get(r.objectId));
const effMode = (R, r) => (hasMask(r) ? (r.mode || R.mode) : "rect");

function rectOfBBox(R, b) {
    const p = R.padding;
    const x0 = clamp01(b.x0 / RT.w - p), y0 = clamp01(b.y0 / RT.h - p), x1 = clamp01(b.x1 / RT.w + p), y1 = clamp01(b.y1 / RT.h + p);
    return { x: x0, y: y0, w: Math.max(MIN_RECT, x1 - x0), h: Math.max(MIN_RECT, y1 - y0) };
}

// リージョンの元の形(重なり処理の前)。W*H の 0..255
function sourceAlpha(R, r) {
    const W = RT.w, H = RT.h;
    if (effMode(R, r) === "mask") return RT.masks.get(r.objectId).alpha;
    if (!r.rect) return null;
    const a = new Uint8ClampedArray(W * H);
    const x0 = Math.round(r.rect.x * W), y0 = Math.round(r.rect.y * H);
    const x1 = Math.min(W, Math.round((r.rect.x + r.rect.w) * W)), y1 = Math.min(H, Math.round((r.rect.y + r.rect.h) * H));
    for (let y = y0; y < y1; y++) a.fill(255, y * W + x0, y * W + x1);
    return a;
}

// 重なりを処理した形を作る(手前から順に、すでに覆われた分を差し引く)
function computeEffective(R) {
    RT.eff = new Map();
    const W = RT.w, H = RT.h;
    if (!W || !H) return;
    const covered = R.occlude ? new Uint8ClampedArray(W * H) : null;
    for (const r of R.regions) {
        if (!r.enabled) continue;
        const src = sourceAlpha(R, r);
        if (!src) continue;
        const out = covered ? new Uint8ClampedArray(W * H) : src;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0, i = 0; y < H; y++) {
            for (let x = 0; x < W; x++, i++) {
                const s = src[i];
                if (!s) continue;
                let a = s;
                if (covered) {
                    a = (s * (255 - covered[i]) / 255) | 0;
                    out[i] = a;
                    if (s > covered[i]) covered[i] = s;
                }
                if (a < 8) continue;
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
        if (x1 >= 0) RT.eff.set(r.id, { alpha: out, bbox: { x0, y0, x1: x1 + 1, y1: y1 + 1 } });
    }
}

// ---------------------------------------------------------------- シーンから取り込む
async function captureScene(studio) {
    const R = state(studio);
    const { w, h } = genSize(studio);
    const [still, caps] = [await studio.captureStill({ width: w, height: h }), await studio.captureObjectMasks({ width: w, height: h })];
    RT.w = w; RT.h = h;
    if (RT.ref?.url) URL.revokeObjectURL(RT.ref.url);
    const url = URL.createObjectURL(still);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    RT.ref = { img, url, blob: still };
    RT.masks = new Map(caps.map(c => [c.id, c]));
    // 新しく映った物をリージョンにする(既存のリージョンはプロンプトを残したまま形だけ更新)
    const known = new Set(R.regions.map(r => r.objectId).filter(Boolean));
    const used = new Set(R.regions.map(r => r.color));
    for (const c of [...caps].sort((a, b) => a.depth - b.depth)) {
        if (known.has(c.id)) continue;
        const color = PALETTE.find(p => !used.has(p)) ?? PALETTE[R.regions.length % PALETTE.length];
        used.add(color);
        const r = { id: uuid(), geomId: uuid(), name: c.name, objectId: c.id, color, enabled: true, mode: "", prompt: "", negative: "", strength: 1, rect: null, rectEdited: false };
        // 奥行きの順に差し込む(手前ほど上)
        const at = R.regions.findIndex(o => o.objectId && RT.masks.get(o.objectId)?.depth > c.depth);
        R.regions.splice(at < 0 ? R.regions.length : at, 0, r);
    }
    for (const r of R.regions) {
        const m = r.objectId && RT.masks.get(r.objectId);
        if (m && !r.rectEdited) r.rect = rectOfBBox(R, m.bbox);
    }
    RT.stale = false;
    computeEffective(R);
}

function sortByDepth(R) {
    const d = r => RT.masks.get(r.objectId)?.depth ?? Infinity;
    R.regions.sort((a, b) => d(a) - d(b));
}

// ---------------------------------------------------------------- bv.regional 文書
function alphaPng(alpha, W, b) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
            img.data[o + 3] = alpha[(y + b.y0) * W + x + b.x0];
        }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
}

function buildDocument(studio) {
    const R = state(studio);
    const W = RT.w, H = RT.h;
    const regions = [];
    R.regions.forEach((r, i) => {
        const e = RT.eff.get(r.id);
        if (!r.enabled || !e) return;
        let geom;
        if (effMode(R, r) === "rect" && !R.occlude) {
            const q = r.rect;
            geom = { id: r.geomId, type: "rect", operation: "add", x: q.x, y: q.y, width: Math.min(q.w, 1 - q.x), height: Math.min(q.h, 1 - q.y) };
        } else {
            const b = e.bbox;
            geom = {
                id: r.geomId, type: "raster_mask", operation: "add",
                x: b.x0 / W, y: b.y0 / H, width: (b.x1 - b.x0) / W, height: (b.y1 - b.y0) / H,
                pixel_width: b.x1 - b.x0, pixel_height: b.y1 - b.y0, data_url: alphaPng(e.alpha, W, b),
            };
        }
        regions.push({
            id: r.id, name: r.name || `Region ${i + 1}`, parent_region_id: null, enabled: true, usage: "generation",
            strength: r.strength, priority: i,
            prompts: { positive_source: r.prompt, negative_source: r.negative },
            mask: { feather: R.feather }, geometry: [geom],
            authoring: { visible: true, locked: false, color: r.color },
        });
    });
    return {
        schema: "bv.regional", version: 2, document_id: R.docId, title: studio.projectName || "VRM Pose Studio",
        canvas: { width: W, height: H },
        prompts: {
            global: { positive_source: R.global.pos, negative_source: R.global.neg },
            background: { positive_source: R.background.pos, negative_source: R.background.neg },
        },
        negative_mode: "auto", overlap: { mode: "joint" }, regions,
    };
}

// 生成タブ(BV Regional Prompt ノード)から使う。シーンが変わっていれば撮り直す
export async function regionalDocument(studio) {
    if (RT.stale || !RT.w || genSize(studio).w !== RT.w || genSize(studio).h !== RT.h) await captureScene(studio);
    else computeEffective(state(studio));
    return buildDocument(studio);
}

// ---------------------------------------------------------------- ワークフロー(API 形式)
function buildWorkflow(doc, g, seed, refImage) {
    const p = {};
    let model, clip, vae;
    if (g.backend === "checkpoint") {
        p.ckpt = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: g.ckpt } };
        model = ["ckpt", 0]; clip = ["ckpt", 1]; vae = ["ckpt", 2];
    } else {
        p.unet = { class_type: "UNETLoader", inputs: { unet_name: g.unet, weight_dtype: "default" } };
        p.clip = { class_type: "CLIPLoader", inputs: { clip_name: g.clip, type: "stable_diffusion", device: "default" } };
        p.vae = { class_type: "VAELoader", inputs: { vae_name: g.vae } };
        model = ["unet", 0]; clip = ["clip", 0]; vae = ["vae", 0];
    }
    if (g.lora) {
        p.lora = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: g.lora, strength_model: g.loraStrength } };
        model = ["lora", 0];
    }
    p.regional = { class_type: "BV Regional Prompt", inputs: { regional_json: JSON.stringify(doc) } };
    let pos, neg;
    if (g.backend === "anima" && g.method === "attention") {
        p.cond = {
            class_type: "BV Regional Anima Conditioning",
            inputs: {
                model, clip, regional: ["regional", 0], base_mode: "disabled", base_strength: 0.2, start_percent: 0, end_percent: g.attnEnd,
                cross_mask_strength: 1, self_mask_strength: 0, base_ratio: 0.1, cross_inject_every_n_blocks: 1, self_inject_every_n_blocks: 1,
                regional_lora_mode: "multipass_legacy",
            },
        };
        model = ["cond", 0]; pos = ["cond", 1]; neg = ["cond", 2];
    } else {
        p.cond = {
            class_type: "BV Regional Native Conditioning",
            inputs: { regional: ["regional", 0], clip, region_strength_multiplier: 1, native_composition: g.composition, hybrid_blend_ratio: 0.35, model },
        };
        pos = ["cond", 0]; neg = ["cond", 1]; model = ["cond", 2];
    }
    if (g.backend === "anima" && g.lllite && g.lllitePatch) {
        p.lllite = { class_type: "BV Regional Anima LLLite", inputs: { model, regional: ["regional", 0], model_patch_name: g.lllitePatch, strength: g.lllitePatchStrength, start_percent: 0, end_percent: g.llliteEnd } };
        model = ["lllite", 0];
    }
    let latent, denoise = 1;
    if (refImage) {
        p.load = { class_type: "LoadImage", inputs: { image: refImage } };
        p.enc = { class_type: "VAEEncode", inputs: { pixels: ["load", 0], vae } };
        latent = ["enc", 0]; denoise = g.denoise;
    } else {
        p.latent = { class_type: "EmptyLatentImage", inputs: { width: doc.canvas.width, height: doc.canvas.height, batch_size: 1 } };
        latent = ["latent", 0];
    }
    p.ks = { class_type: "KSampler", inputs: { model, seed, steps: g.steps, cfg: g.cfg, sampler_name: g.sampler, scheduler: g.scheduler, positive: pos, negative: neg, latent_image: latent, denoise } };
    p.dec = { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae } };
    p.save = { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "vrm_pose_studio/regional" } };
    return p;
}

// ---------------------------------------------------------------- タブ
export function buildRegionalTab(root, studio) {
    let gen = { ...DEFAULT_GEN };
    try { Object.assign(gen, JSON.parse(localStorage.getItem(LS_KEY)) ?? {}); } catch { /* ignore */ }
    const saveGen = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(gen)); } catch { /* ignore */ } };
    let selId = null;
    let running = null;
    let info = null;            // /object_info の必要分

    const R = () => state(studio);
    const sel = () => R().regions.find(r => r.id === selId) ?? null;
    const changed = ({ list = true, editor = true } = {}) => {
        computeEffective(R());
        overlayDirty = true;
        draw();
        if (list) renderLayers();
        if (editor) renderSelected();
        renderJson();
    };

    // ============================================================ 左: キャンバス + レイヤー
    const stage = el("div.vps-rg-stage");
    const cv = el("canvas.vps-rg-canvas");
    const empty = el("div.vps-rg-empty", t("rgEmpty"));
    stage.append(cv, empty);
    const overlay = document.createElement("canvas");   // RT.w × RT.h の色付きマスク
    let overlayDirty = true;
    let opacity = 0.5;

    const modeBtns = ["mask", "rect"].map(m => el("button.vps-btn.small.toggle", {
        dataset: { m }, title: t(m === "mask" ? "rgModeMaskTip" : "rgModeRectTip"),
        onclick: () => { R().mode = m; syncMode(); changed(); },
    }, m === "mask" ? `◐ ${t("rgModeMask")}` : `▭ ${t("rgModeRect")}`));
    const syncMode = () => modeBtns.forEach(b => b.classList.toggle("on", b.dataset.m === R().mode));
    const refBtn = el("button.vps-btn.small.toggle.on", { title: t("rgShowRefTip"), onclick: () => { refBtn.classList.toggle("on"); draw(); } }, `🖼 ${t("rgShowRef")}`);
    const opRange = el("input", { type: "range", min: 0, max: 100, value: 50, title: t("rgOpacity"), oninput: () => { opacity = +opRange.value / 100; overlayDirty = true; draw(); } });
    const captureBtn = el("button.vps-btn.small.primary", { title: t("rgCaptureTip"), onclick: () => doCapture() }, `📷 ${t("rgCapture")}`);
    const staleBadge = el("span.vps-rg-stale", { hidden: true }, `⚠ ${t("rgStale")}`);

    const toolbar = el("div.vps-btn-row.vps-rg-toolbar",
        captureBtn, staleBadge, el("span.vps-rg-sep"), ...modeBtns, el("span.vps-rg-sep"), refBtn,
        el("label.vps-rg-opacity", el("span", t("rgOpacity")), opRange),
    );

    const layerList = el("div.vps-rg-layers");
    const layerTools = el("div.vps-btn-row",
        el("button.vps-btn.small", { title: t("rgFront"), onclick: () => moveSel(-1) }, `▲ ${t("rgFront")}`),
        el("button.vps-btn.small", { title: t("rgBack"), onclick: () => moveSel(1) }, `▼ ${t("rgBack")}`),
        el("button.vps-btn.small", { title: t("rgSortDepthTip"), onclick: () => { sortByDepth(R()); changed(); } }, `⇅ ${t("rgSortDepth")}`),
        el("button.vps-btn.small.danger", { onclick: () => removeSel() }, `🗑 ${t("delete")}`),
    );

    function moveSel(dir) {
        const list = R().regions;
        const i = list.findIndex(r => r.id === selId), j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        changed();
    }
    function removeSel() {
        const list = R().regions;
        const i = list.findIndex(r => r.id === selId);
        if (i < 0) return;
        list.splice(i, 1);
        selId = list[Math.min(i, list.length - 1)]?.id ?? null;
        changed();
    }

    let dragFrom = null;
    function renderLayers() {
        const list = R().regions;
        clear(layerList);
        if (!list.length) { layerList.append(el("div.vps-hint", t("rgNoRegions"))); return; }
        list.forEach((r, i) => {
            const mode = effMode(R(), r);
            const missing = r.objectId && !RT.masks.has(r.objectId) && !RT.stale;
            const row = el("div.vps-rg-layer", {
                draggable: true, dataset: { id: r.id },
                onclick: e => { if (e.target.closest("input")) return; selId = r.id; changed({ editor: true }); },
                ondragstart: e => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; },
                ondragover: e => { e.preventDefault(); row.classList.add("drop"); },
                ondragleave: () => row.classList.remove("drop"),
                ondrop: e => {
                    e.preventDefault(); row.classList.remove("drop");
                    if (dragFrom === null || dragFrom === i) return;
                    const [m] = list.splice(dragFrom, 1);
                    list.splice(i, 0, m);
                    dragFrom = null;
                    changed();
                },
            },
            el("span.vps-rg-num", String(i + 1)),
            el("input", { type: "checkbox", checked: r.enabled, title: t("rgEnabled"), onchange: e => { r.enabled = e.target.checked; changed({ list: false }); } }),
            el("input.vps-rg-color", { type: "color", value: r.color, title: t("rgColor"), oninput: e => { r.color = e.target.value; overlayDirty = true; draw(); }, onchange: () => changed() }),
            el("span.vps-rg-name", { title: r.name }, r.name || `Region ${i + 1}`),
            el(`span.vps-rg-badge.${mode}`, mode === "mask" ? t("rgModeMask") : t("rgModeRect")),
            missing ? el("span.vps-rg-warn", { title: t("rgMissingTip") }, "⚠") : null,
            r.prompt.trim() ? null : el("span.vps-rg-warn", { title: t("rgNoPromptTip") }, "✎"),
            );
            row.classList.toggle("active", r.id === selId);
            layerList.append(row);
        });
    }

    // ---- キャンバスの描画 ----
    let view = { s: 1, ox: 0, oy: 0 };
    function layoutCanvas() {
        const W = RT.w || genSize(studio).w, H = RT.h || genSize(studio).h;
        const bw = stage.clientWidth, bh = stage.clientHeight;
        if (!bw || !bh) return;
        const s = Math.min(bw / W, bh / H);
        const dpr = window.devicePixelRatio || 1;
        cv.style.width = `${Math.round(W * s)}px`;
        cv.style.height = `${Math.round(H * s)}px`;
        cv.width = Math.round(W * s * dpr); cv.height = Math.round(H * s * dpr);
        view = { s: s * dpr, cssS: s };
        draw();
    }
    new ResizeObserver(layoutCanvas).observe(stage);

    function rebuildOverlay() {
        const W = RT.w, H = RT.h;
        overlay.width = W; overlay.height = H;
        if (!W) return;
        const ctx = overlay.getContext("2d");
        const img = ctx.createImageData(W, H);
        const d = img.data;
        const list = R().regions;
        // 手前から塗り、塗った画素はそれより奥では塗らない(見た目も手前が優先)
        for (const r of list) {
            const e = RT.eff.get(r.id);
            if (!e) continue;
            const c = parseInt(r.color.slice(1), 16);
            const cr = c >> 16, cg = (c >> 8) & 255, cb = c & 255;
            const { x0, y0, x1, y1 } = e.bbox;
            for (let y = y0; y < y1; y++) {
                for (let x = x0, i = y * W + x0; x < x1; x++, i++) {
                    const a = e.alpha[i];
                    const o = i * 4;
                    if (a < 8 || d[o + 3]) continue;
                    d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = a * opacity;
                }
            }
        }
        ctx.putImageData(img, 0, 0);
        overlayDirty = false;
    }

    function draw() {
        const ctx = cv.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        empty.hidden = !!RT.w;
        if (!RT.w) return;
        const s = view.s;
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (RT.ref && refBtn.classList.contains("on")) ctx.drawImage(RT.ref.img, 0, 0, RT.w * s, RT.h * s);
        if (overlayDirty) rebuildOverlay();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(overlay, 0, 0, RT.w * s, RT.h * s);
        ctx.imageSmoothingEnabled = true;
        const dpr = window.devicePixelRatio || 1;
        R().regions.forEach((r, i) => {
            const e = RT.eff.get(r.id);
            const isSel = r.id === selId;
            const mode = effMode(R(), r);
            // 領域は自分の矩形、マスクは実際の形の外接矩形を枠として描く
            let bx, by, bw, bh;
            if (mode === "rect" && r.rect) { bx = r.rect.x * RT.w; by = r.rect.y * RT.h; bw = r.rect.w * RT.w; bh = r.rect.h * RT.h; }
            else if (e) { bx = e.bbox.x0; by = e.bbox.y0; bw = e.bbox.x1 - e.bbox.x0; bh = e.bbox.y1 - e.bbox.y0; }
            else return;
            ctx.save();
            ctx.globalAlpha = r.enabled ? 1 : 0.35;
            ctx.strokeStyle = r.color;
            ctx.lineWidth = (isSel ? 3 : 1.5) * dpr;
            ctx.setLineDash(mode === "mask" ? [6 * dpr, 4 * dpr] : []);
            ctx.strokeRect(bx * s, by * s, bw * s, bh * s);
            ctx.setLineDash([]);
            const label = `${i + 1} ${r.name || ""}`;
            ctx.font = `${12 * dpr}px sans-serif`;
            const tw = ctx.measureText(label).width + 8 * dpr;
            ctx.fillStyle = r.color;
            ctx.fillRect(bx * s, by * s, tw, 16 * dpr);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, bx * s + 4 * dpr, by * s + 12 * dpr);
            if (isSel && mode === "rect") {
                ctx.fillStyle = "#fff";
                for (const [hx, hy] of handlePoints(r.rect)) ctx.fillRect(hx * RT.w * s - 4 * dpr, hy * RT.h * s - 4 * dpr, 8 * dpr, 8 * dpr);
            }
            ctx.restore();
        });
        if (drag?.kind === "new" && drag.rect) {
            const q = drag.rect;
            ctx.strokeStyle = "#fff"; ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.lineWidth = 1.5 * dpr;
            ctx.strokeRect(q.x * RT.w * s, q.y * RT.h * s, q.w * RT.w * s, q.h * RT.h * s);
        }
        staleBadge.hidden = !RT.stale;
    }

    const handlePoints = q => [[q.x, q.y], [q.x + q.w, q.y], [q.x, q.y + q.h], [q.x + q.w, q.y + q.h]];

    // ---- キャンバスの操作 ----
    let drag = null;
    const toNorm = e => {
        const b = cv.getBoundingClientRect();
        return { u: (e.clientX - b.left) / b.width, v: (e.clientY - b.top) / b.height };
    };
    function hitHandle(r, u, v) {
        const tol = HANDLE_PX / (view.cssS * Math.max(RT.w, 1));
        const tolV = HANDLE_PX / (view.cssS * Math.max(RT.h, 1));
        const pts = handlePoints(r.rect);
        const names = ["nw", "ne", "sw", "se"];
        for (let k = 0; k < 4; k++) if (Math.abs(pts[k][0] - u) < tol && Math.abs(pts[k][1] - v) < tolV) return names[k];
        return null;
    }
    const inRect = (q, u, v) => q && u >= q.x && u <= q.x + q.w && v >= q.y && v <= q.y + q.h;
    function regionAt(u, v) {
        const x = Math.floor(u * RT.w), y = Math.floor(v * RT.h);
        for (const r of R().regions) {
            const e = RT.eff.get(r.id);
            if (effMode(R(), r) === "rect" ? inRect(r.rect, u, v) : e && e.alpha[y * RT.w + x] > 32) return r;
        }
        return null;
    }

    cv.addEventListener("pointerdown", e => {
        if (!RT.w || e.button !== 0) return;
        const { u, v } = toNorm(e);
        const cur = sel();
        cv.setPointerCapture(e.pointerId);
        if (!e.shiftKey && cur && effMode(R(), cur) === "rect" && cur.rect) {
            const hnd = hitHandle(cur, u, v);
            if (hnd) { drag = { kind: "resize", hnd, r: cur, start: { ...cur.rect } }; return; }
            if (inRect(cur.rect, u, v)) { drag = { kind: "move", r: cur, u, v, start: { ...cur.rect } }; return; }
        }
        const hit = e.shiftKey ? null : regionAt(u, v);
        if (hit) { selId = hit.id; changed(); drag = effMode(R(), hit) === "rect" ? { kind: "move", r: hit, u, v, start: { ...hit.rect } } : null; return; }
        drag = { kind: "new", u, v, rect: null };
    });
    cv.addEventListener("pointermove", e => {
        if (!drag) {
            const cur = sel();
            const { u, v } = toNorm(e);
            cv.style.cursor = cur && effMode(R(), cur) === "rect" && cur.rect && hitHandle(cur, u, v) ? "nwse-resize" : "crosshair";
            return;
        }
        const { u, v } = toNorm(e);
        if (drag.kind === "new") {
            drag.rect = { x: clamp01(Math.min(u, drag.u)), y: clamp01(Math.min(v, drag.v)), w: Math.abs(u - drag.u), h: Math.abs(v - drag.v) };
            draw();
            return;
        }
        const q = drag.r.rect, s0 = drag.start;
        if (drag.kind === "move") {
            q.x = Math.min(1 - s0.w, Math.max(0, s0.x + u - drag.u));
            q.y = Math.min(1 - s0.h, Math.max(0, s0.y + v - drag.v));
        } else {
            let x0 = s0.x, y0 = s0.y, x1 = s0.x + s0.w, y1 = s0.y + s0.h;
            if (drag.hnd.includes("w")) x0 = clamp01(u); else x1 = clamp01(u);
            if (drag.hnd.includes("n")) y0 = clamp01(v); else y1 = clamp01(v);
            q.x = Math.min(x0, x1); q.y = Math.min(y0, y1);
            q.w = Math.max(MIN_RECT, Math.abs(x1 - x0)); q.h = Math.max(MIN_RECT, Math.abs(y1 - y0));
        }
        drag.r.rectEdited = !!drag.r.objectId;
        drag.moved = true;
        scheduleChanged();
    });
    let pendingRaf = 0;
    const scheduleChanged = () => {
        if (pendingRaf) return;
        pendingRaf = requestAnimationFrame(() => { pendingRaf = 0; overlayDirty = true; changed({ list: false, editor: false }); });
    };
    cv.addEventListener("pointerup", () => {
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.kind === "new") {
            if (d.rect && d.rect.w >= MIN_RECT && d.rect.h >= MIN_RECT) {
                const list = R().regions;
                const used = new Set(list.map(r => r.color));
                const r = {
                    id: uuid(), geomId: uuid(), name: `${t("rgManual")} ${list.filter(x => !x.objectId).length + 1}`, objectId: null,
                    color: PALETTE.find(p => !used.has(p)) ?? PALETTE[list.length % PALETTE.length],
                    enabled: true, mode: "", prompt: "", negative: "", strength: 1, rect: d.rect, rectEdited: false,
                };
                list.unshift(r);
                selId = r.id;
                setSubTab("prompt");
            }
            overlayDirty = true;
            changed();
            return;
        }
        if (d.moved) { overlayDirty = true; changed(); }
    });

    // ============================================================ 中: プロンプト / JSON / モデル
    const subTabs = { prompt: el("div.vps-rg-pane"), json: el("div.vps-rg-pane"), model: el("div.vps-rg-pane") };
    const subBtns = Object.keys(subTabs).map(k => el("button.vps-left-tab", { dataset: { k }, onclick: () => setSubTab(k) },
        t(k === "prompt" ? "rgTabPrompt" : k === "json" ? "rgTabJson" : "rgTabModel")));
    function setSubTab(k) {
        for (const b of subBtns) b.classList.toggle("active", b.dataset.k === k);
        for (const [n, p] of Object.entries(subTabs)) p.hidden = n !== k;
        try { localStorage.setItem(LS_TAB, k); } catch { /* ignore */ }
        if (k === "json") renderJson();
    }

    const area = (value, oninput, rows = 3, placeholder = "") => {
        const ta = el("textarea.vps-input.vps-textarea", { rows, placeholder, oninput: () => oninput(ta.value) });
        ta.value = value ?? "";
        return ta;
    };
    const field = (label, ...ctl) => el("div.vps-rg-field", el("div.vps-rg-label", label), ...ctl);

    // プロンプト: 全体
    const globalBox = el("div");
    function renderGlobal() {
        const st = R();
        clear(globalBox).append(
            field(t("rgGlobalPos"), area(st.global.pos, v => { st.global.pos = v; renderJsonLater(); }, 3, t("rgGlobalPosPh"))),
            field(t("rgGlobalNeg"), area(st.global.neg, v => { st.global.neg = v; renderJsonLater(); }, 2)),
            field(t("rgBackground"), area(st.background.pos, v => { st.background.pos = v; renderJsonLater(); }, 2, t("rgBackgroundPh"))),
            el("label.vps-check", { title: t("rgOccludeTip") },
                el("input", { type: "checkbox", checked: st.occlude, onchange: e => { st.occlude = e.target.checked; overlayDirty = true; changed(); } }),
                el("span", t("rgOcclude"))),
            field(t("rgFeather"), numRange(st.feather, 0, 0.1, 0.005, v => { st.feather = v; renderJsonLater(); })),
            field(t("rgPadding"), numRange(st.padding, 0, 0.1, 0.005, v => {
                st.padding = v;
                for (const r of st.regions) { const m = r.objectId && RT.masks.get(r.objectId); if (m && !r.rectEdited) r.rect = rectOfBBox(st, m.bbox); }
                overlayDirty = true; changed({ list: false, editor: false });
            })),
        );
    }
    function numRange(value, min, max, step, onchange) {
        const num = el("input.vps-num", { type: "number", min, max, step, value });
        const rng = el("input", { type: "range", min, max, step, value });
        num.addEventListener("change", () => { rng.value = num.value; onchange(+num.value); });
        rng.addEventListener("input", () => { num.value = rng.value; onchange(+rng.value); });
        return el("div.vps-rg-range", rng, num);
    }

    // プロンプト: 選択中のリージョン
    const selBox = el("div.vps-rg-selbox");
    function renderSelected() {
        clear(selBox);
        const r = sel();
        if (!r) { selBox.append(el("div.vps-hint", t("rgSelectHint"))); return; }
        const st = R();
        const nameIn = el("input.vps-input", { type: "text", value: r.name, oninput: () => { r.name = nameIn.value; draw(); renderJsonLater(); }, onchange: () => renderLayers() });
        const modeSel = el("select.vps-select", {
            disabled: !hasMask(r),
            onchange: () => { r.mode = modeSel.value; overlayDirty = true; changed(); },
        }, [["", `${t("rgFollow")} (${st.mode === "mask" ? t("rgModeMask") : t("rgModeRect")})`], ["mask", t("rgModeMask")], ["rect", t("rgModeRect")]]
            .map(([v, l]) => el("option", { value: v, selected: v === r.mode }, l)));
        selBox.append(
            el("h4.vps-settings-h", el("span.vps-rg-dot", { style: { background: r.color } }), ` ${t("rgSelected")}`),
            field(t("name"), nameIn),
            field(t("rgPrompt"), area(r.prompt, v => { r.prompt = v; renderJsonLater(); renderLayersLater(); }, 4, t("rgPromptPh"))),
            field(t("rgNegative"), area(r.negative, v => { r.negative = v; renderJsonLater(); }, 2)),
            field(t("rgStrength"), numRange(r.strength, 0, 2, 0.05, v => { r.strength = v; renderJsonLater(); })),
            field(t("rgShape"), modeSel, r.objectId ? null : el("div.vps-hint", t("rgManualHint"))),
            r.objectId && r.rectEdited ? el("button.vps-btn.small", {
                onclick: () => { r.rectEdited = false; const m = RT.masks.get(r.objectId); if (m) r.rect = rectOfBBox(st, m.bbox); overlayDirty = true; changed(); },
            }, `↺ ${t("rgResetRect")}`) : "",
        );
    }
    let jsonTimer = 0, layersTimer = 0;
    const renderJsonLater = () => { clearTimeout(jsonTimer); jsonTimer = setTimeout(renderJson, 300); };
    const renderLayersLater = () => { clearTimeout(layersTimer); layersTimer = setTimeout(renderLayers, 300); };

    subTabs.prompt.append(
        el("h4.vps-settings-h", t("rgGlobal")), globalBox,
        selBox,
    );

    // JSON
    const jsonPre = el("pre.vps-rg-json");
    function renderJson() {
        if (subTabs.json.hidden) return;
        if (!RT.w) { jsonPre.textContent = t("rgEmpty"); return; }
        const doc = buildDocument(studio);
        // 画像データは長いので省略して見せる
        jsonPre.textContent = JSON.stringify(doc, (k, v) => (k === "data_url" ? `${v.slice(0, 40)}… (${Math.round(v.length / 1024)} KB)` : v), 2);
    }
    subTabs.json.append(
        el("div.vps-btn-row",
            el("button.vps-btn.small", {
                onclick: async () => {
                    try { await navigator.clipboard.writeText(JSON.stringify(await regionalDocument(studio))); toast(t("copied"), "success"); } catch (e) { toast(e.message, "error"); }
                },
            }, `📋 ${t("rgCopyJson")}`),
            el("button.vps-btn.small", {
                onclick: async () => {
                    const blob = new Blob([JSON.stringify(await regionalDocument(studio), null, 2)], { type: "application/json" });
                    const a = el("a", { href: URL.createObjectURL(blob), download: `${studio.projectName || "regional"}.bv-regional.json` });
                    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                },
            }, `⬇ ${t("rgSaveJson")}`)),
        el("div.vps-hint", t("rgJsonHint")),
        jsonPre,
    );

    // モデル・サンプラー
    const modelBox = el("div");
    const optList = (values, cur, { empty } = {}) => [
        ...(empty ? [el("option", { value: "" }, empty)] : []),
        ...values.map(v => el("option", { value: v, selected: v === cur }, v)),
    ];
    function select(key, values, opts = {}) {
        const s = el("select.vps-select", { onchange: () => { gen[key] = s.value; saveGen(); opts.after?.(); } }, optList(values, gen[key], opts));
        if (!opts.empty && !values.includes(gen[key]) && values.length) { gen[key] = values[0]; s.value = values[0]; }
        return s;
    }
    function num(key, min, max, step) {
        return el("input.vps-num", { type: "number", min, max, step, value: gen[key], onchange: e => { gen[key] = +e.target.value; saveGen(); } });
    }
    function check(key, label, after) {
        return el("label.vps-check", el("input", { type: "checkbox", checked: gen[key], onchange: e => { gen[key] = e.target.checked; saveGen(); after?.(); } }), el("span", label));
    }
    // 正規表現を順に試し、最初に当たったものを既定にする
    const pick = (list, ...res) => res.reduce((hit, re) => hit ?? list.find(v => re.test(v)), undefined) ?? list[0] ?? "";
    function renderModel() {
        clear(modelBox);
        if (!info) { modelBox.append(el("div.vps-hint", t("loading"))); return; }
        if (!gen.unet || !info.unet.includes(gen.unet)) gen.unet = pick(info.unet, /(^|[\\/])anima_base/i, /(^|[\\/])anima/i, /anima/i);
        if (!gen.clip || !info.clip.includes(gen.clip)) gen.clip = pick(info.clip, /qwen_3_06b/i);
        if (!gen.vae || !info.vae.includes(gen.vae)) gen.vae = pick(info.vae, /qwen_image_vae/i);
        if (!gen.lllitePatch || !info.patches.includes(gen.lllitePatch)) gen.lllitePatch = pick(info.patches, /lllite-regional/i);
        const isAnima = gen.backend === "anima";
        modelBox.append(...[
            field(t("rgPreset"), el("div.vps-btn-row",
                el("button.vps-btn.small", { onclick: () => applyPreset("anima") }, t("rgPresetAnima")),
                el("button.vps-btn.small", { onclick: () => applyPreset("turbo") }, t("rgPresetTurbo")))),
            field(t("rgBackend"), (() => {
                const s = el("select.vps-select", { onchange: () => { gen.backend = s.value; saveGen(); renderModel(); } },
                    [["anima", "Anima (UNET + Qwen3 0.6B)"], ["checkpoint", t("rgCheckpoint")]].map(([v, l]) => el("option", { value: v, selected: v === gen.backend }, l)));
                return s;
            })()),
            isAnima ? [
                field("UNET", select("unet", info.unet)),
                field("CLIP", select("clip", info.clip)),
                field("VAE", select("vae", info.vae)),
            ] : field("Checkpoint", select("ckpt", info.ckpt)),
            field("LoRA", select("lora", info.lora, { empty: t("setNone") }), num("loraStrength", -4, 4, 0.05)),
            isAnima ? field(t("rgMethod"), select("method", ["native", "attention"], { after: renderModel })) : null,
            !isAnima || gen.method === "native" ? field(t("rgComposition"), select("composition", ["blend", "exclusive", "hybrid"])) : field(t("rgAttnEnd"), num("attnEnd", 0, 1, 0.05)),
            isAnima ? el("div.vps-rg-group",
                check("lllite", t("rgLllite"), renderModel),
                gen.lllite ? [
                    info.patches.length ? field(t("rgLllitePatch"), select("lllitePatch", info.patches)) : el("div.vps-hint.warn", t("rgNoPatch")),
                    field(t("rgStrength"), num("lllitePatchStrength", 0, 2, 0.05)),
                    field(t("rgLlliteEnd"), num("llliteEnd", 0, 1, 0.05)),
                ] : null,
                el("div.vps-hint", t("rgLlliteHint"))) : null,
            el("h4.vps-settings-h", t("rgSampler")),
            field("Steps", num("steps", 1, 200, 1)),
            field("CFG", num("cfg", 0, 30, 0.1)),
            field("Sampler", select("sampler", info.samplers)),
            field("Scheduler", select("scheduler", info.schedulers)),
            el("div.vps-rg-group",
                check("img2img", t("rgImg2Img"), renderModel),
                gen.img2img ? field("Denoise", num("denoise", 0.05, 1, 0.05)) : null,
                el("div.vps-hint", t("rgImg2ImgHint"))),
        ].flat().filter(Boolean));
    }
    function applyPreset(k) {
        const p = SAMPLER_PRESETS[k];
        Object.assign(gen, { ...p, backend: "anima" });
        if (p.lora && !info?.lora.includes(p.lora)) gen.lora = info?.lora.find(v => /anima-turbo-lora/i.test(v)) ?? "";
        saveGen();
        renderModel();
    }
    subTabs.model.append(modelBox);

    const comfyStatus = el("div.vps-ip-status");
    async function loadInfo() {
        const get = async name => (await (await fetch(`/api/object_info/${encodeURIComponent(name)}`)).json())[name];
        try {
            const bv = await Promise.all(BV_NODES.map(n => get(n).catch(() => null)));
            const missing = BV_NODES.filter((_, i) => !bv[i]);
            const [unet, clip, vae, ckpt, lora, ks] = await Promise.all(["UNETLoader", "CLIPLoader", "VAELoader", "CheckpointLoaderSimple", "LoraLoaderModelOnly", "KSampler"].map(get));
            const combo = (node, key) => node?.input?.required?.[key]?.[0] ?? [];
            info = {
                unet: combo(unet, "unet_name"), clip: combo(clip, "clip_name"), vae: combo(vae, "vae_name"), ckpt: combo(ckpt, "ckpt_name"),
                lora: combo(lora, "lora_name"), samplers: combo(ks, "sampler_name"), schedulers: combo(ks, "scheduler"),
                patches: combo(bv[2], "model_patch_name"), missing,
            };
            if (missing.length) { comfyStatus.textContent = `${t("rgNeedBv")}: ${missing.join(", ")}`; comfyStatus.className = "vps-ip-status error"; }
            else { comfyStatus.textContent = t("rgBvReady"); comfyStatus.className = "vps-ip-status ok"; }
        } catch (e) {
            comfyStatus.textContent = `${t("ipNoComfy")}: ${e.message}`;
            comfyStatus.className = "vps-ip-status error";
        }
        renderModel();
        refreshButtons();
    }

    // ============================================================ 右: 生成・結果
    const seedChk = el("input", { type: "checkbox", checked: gen.randomSeed, onchange: () => { gen.randomSeed = seedChk.checked; saveGen(); } });
    const seedIn = el("input.vps-num.vps-rg-seed", { type: "number", min: 0, value: gen.seed, onchange: () => { gen.seed = +seedIn.value; saveGen(); } });
    const status = el("div.vps-ip-status");
    const setStatus = (msg, kind = "") => { status.textContent = msg; status.className = `vps-ip-status ${kind}`; };
    const runBtn = el("button.vps-btn.primary", { onclick: () => run() }, `▶ ${t("genRun")}`);
    const stopBtn = el("button.vps-btn.danger", { disabled: true, onclick: async () => { await interruptPrompt(running?.promptId); setStatus(t("ipAborted")); } }, `■ ${t("genStop")}`);
    const results = el("div.vps-gen-results", el("div.vps-empty", t("genNoResults")));
    const refreshButtons = () => {
        runBtn.disabled = !!running || !info || info.missing.length > 0;
        stopBtn.disabled = !running;
        captureBtn.disabled = !!running;
    };

    async function uploadRef() {
        const fd = new FormData();
        fd.append("image", new File([RT.ref.blob], "regional_ref.png", { type: "image/png" }));
        fd.append("subfolder", "vrm_pose_studio");
        fd.append("type", "input");
        fd.append("overwrite", "true");
        const res = await fetch("/api/upload/image", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`upload: HTTP ${res.status}`);
        const j = await res.json();
        return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
    }

    async function run() {
        if (running) return;
        running = { promptId: null };
        refreshButtons();
        try {
            if (RT.stale || !RT.w) { setStatus(t("rgCapturing")); await captureScene(studio); changed(); }
            const doc = buildDocument(studio);
            if (!doc.regions.length) throw new Error(t("rgNoActive"));
            if (gen.randomSeed) { gen.seed = Math.floor(Math.random() * 2 ** 48); seedIn.value = gen.seed; saveGen(); }
            const refName = gen.img2img ? await uploadRef() : null;
            const wf = buildWorkflow(doc, gen, gen.seed, refName);
            running.promptId = await queuePrompt(wf);
            const { files, sec } = await waitPrompt(running.promptId, msg => setStatus(msg), { nodeIds: ["save"] });
            addResults(files, gen.seed);
            setStatus(`${t("genDone")} · ${files.length} · ${sec}s`, "ok");
        } catch (e) {
            setStatus(e.message, "error");
        } finally {
            running = null;
            refreshButtons();
        }
    }

    async function importResult(f, kind) {
        try {
            const blob = await (await fetch(viewUrl(f))).blob();
            const it = await api.uploadAsset(kind, new File([blob], f.filename, { type: blob.type }));
            if (kind === "props") await addPropFromAsset(studio, it);
            else await studio.setEnv({ background: { mode: "image", url: it.url, name: it.name } });
            toast(`${f.filename} → ${kind === "props" ? t("addProp") : t("background")}`, "success");
        } catch (e) { toast(e.message, "error"); }
    }
    function addResults(files, seed) {
        results.querySelector(".vps-empty")?.remove();
        for (const f of files) {
            const url = viewUrl(f);
            results.prepend(el("div.vps-render-card",
                el("div.vps-render-media", el("a", { href: url, target: "_blank" }, el("img", { src: url, loading: "lazy" }))),
                el("div.vps-render-info",
                    el("div.vps-render-name", `${f.filename} · seed ${seed}`),
                    el("div.vps-btn-row",
                        el("button.vps-btn.small", { onclick: () => importResult(f, "backgrounds") }, `🌄 ${t("genToBg")}`),
                        el("button.vps-btn.small", { onclick: () => importResult(f, "props") }, `🖼 ${t("genToProp")}`),
                        el("button.vps-btn.small", { title: t("rgUseSeedTip"), onclick: () => { seedChk.checked = gen.randomSeed = false; gen.seed = seed; seedIn.value = seed; saveGen(); } }, "🎲"),
                        el("a.vps-btn.small", { href: url, download: f.filename }, "⬇"),
                    ),
                ),
            ));
        }
    }

    async function doCapture() {
        captureBtn.disabled = true;
        try {
            await captureScene(studio);
            if (!sel()) selId = R().regions[0]?.id ?? null;
            overlayDirty = true;
            layoutCanvas();
            changed();
            if (!RT.masks.size) toast(t("rgNothingVisible"), "error");
        } catch (e) { toast(e.message, "error"); console.error(e); }
        finally { captureBtn.disabled = !!running; }
    }

    // ============================================================ 組み立て
    root.append(el("div.vps-rg",
        el("div.vps-rg-layerpane",
            el("h4.vps-settings-h", t("rgLayers")),
            layerTools,
            layerList,
        ),
        el("div.vps-rg-left",
            toolbar,
            stage,
            el("div.vps-hint", t("rgCanvasHint")),
        ),
        el("div.vps-rg-mid", el("div.vps-left-tabs", subBtns), ...Object.values(subTabs)),
        el("div.vps-rg-right",
            comfyStatus,
            el("div.vps-rg-seedrow", el("label.vps-check", seedChk, el("span", t("genRandomSeed"))), seedIn),
            el("div.vps-btn-row", runBtn, stopBtn),
            status,
            el("h4.vps-settings-h", t("genResults")),
            results,
        ),
    ));
    let sub = "prompt";
    try { sub = localStorage.getItem(LS_TAB) || "prompt"; } catch { /* ignore */ }
    setSubTab(subTabs[sub] ? sub : "prompt");

    // シーンが変わったら撮り直しが必要(表示だけ。生成時・タブを開いたときに撮り直す)
    const markStale = () => { if (!RT.stale) { RT.stale = true; if (root.classList.contains("active")) draw(); } };
    for (const ev of ["edited", "frame", "objects", "output", "cameras", "env"]) studio.addEventListener(ev, markStale);
    studio.addEventListener("regional", () => {
        selId = null; RT.masks = new Map(); RT.stale = true;
        renderGlobal(); syncMode(); changed();
    });
    document.addEventListener("keydown", e => {
        if (!root.classList.contains("active") || e.target.closest("input, textarea, select, [contenteditable]")) return;
        if (e.key === "Delete") { e.preventDefault(); removeSel(); }
    });

    renderGlobal(); syncMode(); renderLayers(); renderSelected(); refreshButtons();
    return {
        async show() {
            if (!info) loadInfo();
            layoutCanvas();
            if (RT.stale) await doCapture();
        },
    };
}
