// outliner.js — 左パネル(追加ボタン・オブジェクト一覧)

import { t } from "../i18n.js";
import { el, clear, toast, promptText } from "../util.js";
import { pickAsset } from "./assets.js";
import { PRIMITIVES, LIGHT_KINDS } from "../engine/objects.js";
import { WIND_TRACK } from "../engine/timeline.js";


export const ICON = { actor: "🧍", prop: "📦", light: "💡", camera: "🎥", scene: "🌄" };

// 新しいライトは被写体の斜め前上に置き、胸の高さへ向ける
async function addLight(studio, kind) {
    const n = studio.list().filter(o => o.type === "light").length;
    const obj = await studio.addObject({ type: "light", name: `${t("light_" + kind)} ${n + 1}`, src: { kind } }, { record: false });
    const side = n % 2 ? -1 : 1;
    obj.root.position.set(1.6 * side, kind === "directional" ? 3 : 2.4, 1.8);
    obj.root.lookAt(0, 1.1, 0);
    studio.commitEdit();
}

export async function addActorFromAsset(studio, it) {
    toast(`${t("loading")} ${it.name}`);
    try {
        const n = studio.actors().length;
        const obj = await studio.addObject({ type: "actor", name: it.name.replace(/\.vrm$/i, ""), src: { url: it.url, name: it.name } });
        // 2体目以降は横に並べる
        if (n > 0) { obj.root.position.x = (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 0.7; studio.commitEdit(); }
        toast(it.name, "success");
    } catch (e) {
        toast(`${t("loadFailed")}: ${e.message}`, "error", 6000);
    }
}

export async function addPropFromAsset(studio, it) {
    const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(it.ext);
    try {
        await studio.addObject({
            type: "prop",
            name: it.name.replace(/\.[^.]+$/, ""),
            src: { kind: isImage ? "image" : "gltf", url: it.url, name: it.name },
        });
    } catch (e) {
        toast(`${t("loadFailed")}: ${e.message}`, "error", 6000);
    }
}

export function buildOutliner(root, studio) {
    const shapeMenu = el("div.vps-menu.hidden",
        PRIMITIVES.map(s => el("button.vps-menu-item", {
            onclick: async () => {
                shapeMenu.classList.add("hidden");
                await studio.addObject({ type: "prop", name: t("shape_" + s), src: { kind: "primitive", shape: s } });
            },
        }, t("shape_" + s))));
    const lightMenu = el("div.vps-menu.hidden",
        LIGHT_KINDS.map(k => el("button.vps-menu-item", {
            onclick: async () => { lightMenu.classList.add("hidden"); await addLight(studio, k); },
        }, t("light_" + k))));
    document.addEventListener("mousedown", e => {
        if (!shapeMenu.contains(e.target) && !e.target.closest(".vps-shape-btn")) shapeMenu.classList.add("hidden");
        if (!lightMenu.contains(e.target) && !e.target.closest(".vps-light-btn")) lightMenu.classList.add("hidden");
    });

    const addBar = el("div.vps-add-bar",
        el("button.vps-btn", { onclick: async () => { const it = await pickAsset("models", { title: t("addModel") }); if (it) addActorFromAsset(studio, it); } }, `🧍 ${t("addModel")}`),
        el("button.vps-btn", { onclick: async () => { const it = await pickAsset("props", { title: t("addProp"), filter: i => [".glb", ".gltf", ".vrm"].includes(i.ext) }); if (it) addPropFromAsset(studio, it); } }, `📦 ${t("addProp")}`),
        el("div.vps-rel", el("button.vps-btn.vps-shape-btn", { onclick: () => shapeMenu.classList.toggle("hidden") }, `🔷 ${t("addPrimitive")}`), shapeMenu),
        el("button.vps-btn", { onclick: async () => { const it = await pickAsset("props", { title: t("addImage"), filter: i => [".png", ".jpg", ".jpeg", ".webp"].includes(i.ext) }); if (it) addPropFromAsset(studio, it); } }, `🖼 ${t("addImage")}`),
        el("div.vps-rel", el("button.vps-btn.vps-light-btn", { onclick: () => lightMenu.classList.toggle("hidden") }, `💡 ${t("addLight")}`), lightMenu),
    );

    const list = el("div.vps-outliner-list");
    root.append(el("div.vps-panel-title", t("outliner")), addBar, list);

    const row = (id, icon, label, { obj, depth = 0 } = {}) => {
        const sel = studio.selection?.id === id;
        const r = el(`div.vps-row${sel ? ".selected" : ""}`, {
            style: { paddingLeft: `${8 + depth * 14}px` },
            onclick: () => studio.select(id),
            ondblclick: async () => {
                if (!obj) return;
                const n = await promptText(t("name"), obj.name);
                if (n) studio.rename(id, n);
            },
        },
            el("span.vps-row-icon", icon),
            el("span.vps-row-label", label),
            studio.timeline.hasKeys(id) ? el("span.vps-row-badge", { title: "keyframes" }, "◆") : null,
        );
        if (obj) {
            r.append(
                el("button.vps-icon-btn", { title: t("lock"), onclick: e => { e.stopPropagation(); studio.setLocked(id, !obj.locked); } }, obj.locked ? "🔒" : "🔓"),
                el("button.vps-icon-btn", { title: t("visible"), onclick: e => { e.stopPropagation(); studio.setVisible(id, !obj.visible); } }, obj.visible ? "👁" : "◌"),
            );
        }
        return r;
    };

    const render = () => {
        clear(list);
        list.append(row("scene", ICON.scene, t("scene")));
        const wind = row(WIND_TRACK, "🌬", t("wind"), { depth: 1 });
        const shown = studio.env.windHelperVisible;
        wind.append(el("button.vps-icon-btn", { title: t("windHelperTip"), onclick: e => { e.stopPropagation(); studio.setWindHelperVisible(!shown); } }, shown ? "👁" : "◌"));
        list.append(wind);
        // カメラ(🎬 = 今のフレームで使われているカメラ)
        const cutId = studio.cutCameraAt();
        list.append(el("div.vps-group-head", `🎥 ${t("cameras")}`,
            el("button.vps-icon-btn", { title: t("camFromView"), onclick: e => { e.stopPropagation(); studio.addCamera(); } }, "＋")));
        for (const c of studio.cams.list()) {
            const r = row(c.id, "", c.name, { depth: 1 });
            r.querySelector(".vps-row-icon").append(el("span.vps-cam-dot", { style: { background: c.color } }));
            if (c.id === cutId) r.append(el("span.vps-row-badge.cut", { title: t("cutActive") }, "🎬"));
            r.addEventListener("dblclick", async () => {
                const n = await promptText(t("name"), c.name);
                if (n) studio.renameCamera(c.id, n);
            });
            list.append(r);
        }
        list.append(el("div.vps-group-head", `🧍 ${t("objectsHead")}`));
        const objs = studio.list();
        if (!objs.length) list.append(el("div.vps-empty", t("noObjects")));
        // アタッチされたプロップは親の人物の下に字下げして表示
        const children = id => objs.filter(o => o.parentRef?.actorId === id);
        for (const o of objs) {
            if (o.parentRef && studio.get(o.parentRef.actorId)) continue;
            list.append(row(o.id, ICON[o.type], o.name, { obj: o }));
            for (const c of children(o.id)) list.append(row(c.id, ICON[c.type], `${c.name}  ⟵ ${c.parentRef.bone}`, { obj: c, depth: 1 }));
        }
    };
    for (const ev of ["objects", "selection", "timeline", "cameras", "wind-helper"]) studio.addEventListener(ev, render);
    // 再生・シークでカットが変わったら 🎬 を付け替える
    let lastCut = null;
    studio.addEventListener("frame", () => { const c = studio.cutCameraAt(); if (c !== lastCut) { lastCut = c; render(); } });
    render();
}
