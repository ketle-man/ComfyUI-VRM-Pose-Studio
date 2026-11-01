// settings.js — 操作環境設定(マウス・描画・既定モデル・言語)。サーバーの data/settings.json に保存する
//
// 既定モデル defaultModel: "" = 自動(models の先頭)/ NONE_MODEL = 読み込まない / "<source>/<path>" = そのファイル
// 新規作成時と、前回のプロジェクトが無い状態での起動時に読み込む

import { api } from "../api.js";
import { t, getLang, LANGS } from "../i18n.js";
import { el, openModal, slider, field, toast, fmtBytes } from "../util.js";
import { addActorFromAsset } from "./outliner.js";

export const NONE_MODEL = "__none__";

export const DEFAULT_SETTINGS = {
    lang: null,
    zoomMode: "wheel",        // "wheel" | "ctrlDrag"
    orbitButtons: "left",     // "left" | "middle"
    rotateSpeed: 1,
    zoomSpeed: 1,
    panSpeed: 1,
    superSample: false,
    defaultModel: "",
};

let _settings = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
    try { _settings = { ...DEFAULT_SETTINGS, ...(await api.getSettings()) }; } catch { /* 既定値で起動 */ }
    return _settings;
}

export function getSettings() { return _settings; }

// 連続で変更しても古い内容で上書きされないよう、保存は直列にして毎回その時点の最新値を送る
let _saving = Promise.resolve();
function saveSettings(patch) {
    _settings = { ..._settings, ...patch };
    _saving = _saving.catch(() => {}).then(() => api.saveSettings(_settings));
    return _saving.then(() => _settings);
}

export function applySettings(studio, s = _settings) {
    const vp = studio.vp;
    vp.setZoomMode(s.zoomMode);
    vp.setOrbitButtons(s.orbitButtons);
    vp.setMouseSpeeds({ rotate: s.rotateSpeed, zoom: s.zoomSpeed, pan: s.panSpeed });
    if (vp.superSample !== !!s.superSample) vp.setSuperSample(s.superSample);
}

const modelKey = it => `${it.source}/${it.path}`;

// 既定モデルのアセットを返す(読み込まない・見つからないときは null)
export async function resolveDefaultModel() {
    const sel = _settings.defaultModel ?? "";
    if (sel === NONE_MODEL) return null;
    const list = await api.listAssets("models").catch(() => []);
    // 選んだファイルが消えていたら自動(先頭)にフォールバックする
    return list.find(m => modelKey(m) === sel) ?? list[0] ?? null;
}

export async function loadDefaultModel(studio) {
    const it = await resolveDefaultModel();
    if (it) await addActorFromAsset(studio, it);
}

export function openSettingsDialog(studio) {
    const s = _settings;
    const set = async patch => {
        try {
            await saveSettings(patch);
            applySettings(studio);
        } catch (e) { toast(e.message, "error"); }
    };
    const radio = (name, options, value, onChange) => el("div.vps-radio-group",
        options.map(([v, label, hint]) => {
            const r = el("input", { type: "radio", name, value: v, checked: v === value, onchange: () => r.checked && onChange(v) });
            return el("label.vps-check", { title: hint ?? "" }, r, el("span", label), hint ? el("span.vps-hint", ` — ${hint}`) : null);
        }));
    const check = (label, value, hint, onChange) => {
        const c = el("input", { type: "checkbox", checked: !!value, onchange: () => onChange(c.checked) });
        return el("label.vps-check", c, el("span", label), hint ? el("span.vps-hint", ` — ${hint}`) : null);
    };
    const h = text => el("h4.vps-settings-h", text);

    // ---- 既定モデル ----
    const modelSel = el("select.vps-select");
    const modelInfo = el("div.vps-hint");
    const fillModels = async () => {
        modelInfo.textContent = t("loading");
        const list = await api.listAssets("models").catch(e => { modelInfo.textContent = e.message; return []; });
        modelSel.replaceChildren(
            el("option", { value: "" }, list.length ? `${t("setAuto")} (${list[0].name})` : `${t("setAuto")} (—)`),
            ...list.map(m => el("option", { value: modelKey(m) }, `${m.source === "local" ? "" : `[${m.source}] `}${m.name}  (${fmtBytes(m.size)})`)),
            el("option", { value: NONE_MODEL }, t("setNone")),
        );
        const cur = s.defaultModel ?? "";
        if (cur && cur !== NONE_MODEL && !list.some(m => modelKey(m) === cur)) modelSel.prepend(el("option", { value: cur }, `${cur} (${t("setMissing")})`));
        modelSel.value = cur;
        modelInfo.textContent = `${list.length} ${t("setModelsFound")}`;
    };
    modelSel.addEventListener("change", async () => {
        await set({ defaultModel: modelSel.value });
        modelInfo.textContent = t("setModelSaved");
    });
    fillModels();

    const langSel = el("select.vps-select", {
        onchange: async () => { await saveSettings({ lang: langSel.value }); location.reload(); },
    }, LANGS.map(l => el("option", { value: l, selected: l === getLang() }, l === "ja" ? "日本語" : "English")));

    const body = el("div.vps-settings",
        h(`🖱 ${t("setMouse")}`),
        el("div.vps-hint", t("setOrbitLabel")),
        radio("vps-orbit", [
            ["left", t("setOrbitLeft")],
            ["middle", t("setOrbitMiddle")],
        ], s.orbitButtons, v => set({ orbitButtons: v })),
        el("div.vps-hint", t("setZoomLabel")),
        radio("vps-zoom", [
            ["wheel", t("setZoomWheel")],
            ["ctrlDrag", t("setZoomCtrl"), t("setZoomCtrlHint")],
        ], s.zoomMode, v => set({ zoomMode: v })),
        el("div.vps-hint", t("setAltZoom")),
        slider({ label: t("setRotateSpeed"), min: 0.2, max: 3, step: 0.1, value: s.rotateSpeed, onChange: v => set({ rotateSpeed: v }) }),
        slider({ label: t("setZoomSpeed"), min: 0.2, max: 3, step: 0.1, value: s.zoomSpeed, onChange: v => set({ zoomSpeed: v }) }),
        slider({ label: t("setPanSpeed"), min: 0.2, max: 3, step: 0.1, value: s.panSpeed, onChange: v => set({ panSpeed: v }) }),

        h(`🖼 ${t("setRendering")}`),
        check(t("setSuperSample"), s.superSample, t("setSuperSampleHint"), v => set({ superSample: v })),

        h(`🧍 ${t("setDefaultModel")}`),
        el("div.vps-btn-row",
            modelSel,
            el("button.vps-btn.small", { title: t("refresh"), onclick: fillModels }, "↺"),
            el("button.vps-btn.small.primary", {
                onclick: async () => {
                    const it = await resolveDefaultModel();
                    if (it) addActorFromAsset(studio, it);
                    else toast(t("setNone"));
                },
            }, t("setLoadNow")),
        ),
        modelInfo,
        el("div.vps-hint", t("setDefaultModelHint")),

        h(`🌐 ${t("lang")}`),
        field(t("lang"), langSel),
    );
    openModal(`⚙ ${t("settings")}`, body);
}
