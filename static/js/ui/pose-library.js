// pose-library.js — ポーズライブラリ(3D Pose Editor の Pose Library と同じ使い勝手)
//
// ・ポーズ(.json / .vroidpose)とモーション(.vrma)をサムネイルの一覧で見て、クリックで選択中の人物に当てる
//   (.vrma は確認のうえ、今の時刻からキーフレームとして取り込む)
// ・フォルダ・名前・種類・お気に入りで絞り込み、右クリックでお気に入り / 左右反転して適用 / メモ / 名前の変更 / 削除 /
//   サムネイルの作り直し(正面・背面)
// ・サムネイルは、選択中の人物の VRM を画面外のレンダラーに読み込み、ポーズを当てて描く(カードが見えたときに 1 件ずつ)
// ・3D Pose Editor の poses/ にあるファイルは読み取り専用(名前の変更・削除はできない)

import * as THREE from "../../vendor/three.module.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import { el, clear, toast, openModal, promptText, confirmDialog } from "../util.js";
import { Actor } from "../engine/objects.js";
import { importMotion } from "./motion.js";

const THUMB = 256;
const CARD_PX = { s: 100, m: 140, l: 190 };
const EXT_COLORS = { ".json": "#6fd68a", ".vrma": "#ff8ac8", ".vroidpose": "#6ccff6" };
const SOURCE_LABEL = { local: "Studio", "pose-editor": "3D Pose Editor" };

const pref = (k, d) => { try { return localStorage.getItem(`vps:plib:${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`vps:plib:${k}`, v); } catch { /* ignore */ } };

export function openPoseLibrary(studio) {
    const actor = () => {
        const o = studio.selectedObject();
        return o?.type === "actor" ? o : studio.actors()[0] ?? null;
    };

    // ---- ツールバー ----
    const folderSel = el("select.vps-select");
    const search = el("input.vps-input", { type: "search", placeholder: t("plibSearch") });
    const filterSel = el("select.vps-select", {},
        [["all", t("plibAll")], ["favorite", `⭐ ${t("plibFavorites")}`], [".json", ".json"], [".vroidpose", ".vroidpose"], [".vrma", ".vrma"]]
            .map(([v, l]) => el("option", { value: v }, l)));
    const sizeSel = el("select.vps-select", {}, [["s", "S"], ["m", "M"], ["l", "L"]].map(([v, l]) => el("option", { value: v }, l)));
    sizeSel.value = pref("size", "m");
    filterSel.value = pref("filter", "all");
    const saveBtn = el("button.vps-btn.small.primary", { title: t("plibSaveTip"), onclick: () => saveCurrent() }, `💾 ${t("plibSave")}`);
    const reloadBtn = el("button.vps-btn.small", { title: t("refresh"), onclick: () => reload() }, "↻");
    const target = el("span.vps-plib-target");
    const grid = el("div.vps-plib-grid");
    const status = el("div.vps-hint.vps-plib-status");

    const body = el("div.vps-plib",
        el("div.vps-plib-toolbar", folderSel, search, filterSel, sizeSel, saveBtn, reloadBtn),
        target,
        el("div.vps-plib-scroll", grid),
        status,
    );
    let thumbs = null;
    const { close, box } = openModal(`📚 ${t("poseLibrary")}`, body, {
        wide: true,
        onClose: () => { observer.disconnect(); thumbs?.dispose(); document.getElementById("vps-plib-ctx")?.remove(); },
    });
    box.classList.add("vps-plib-modal");

    let items = [];

    // ---- サムネイル ----
    const pending = new Map();
    const ensureThumb = item => {
        if (item.thumb) return Promise.resolve(true);
        const a = actor();
        if (!a) return Promise.resolve(false);
        thumbs ??= createThumbRenderer(a.src.url);
        if (pending.has(item.id)) return pending.get(item.id);
        const job = thumbs.render(item, false).then(async png => {
            if (!png) return false;
            await api.post(`/vps/api/poselib/thumb/${item.id}`, { image: png });
            item.thumb = `/vps/api/poselib/thumb/${item.id}`;
            return true;
        }).catch(e => { console.warn("[VPS] pose thumbnail failed", e); return false; })
            .finally(() => pending.delete(item.id));
        pending.set(item.id, job);
        return job;
    };
    const observer = new IntersectionObserver(entries => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer.unobserve(e.target);
            e.target._onVisible?.();
        }
    }, { root: grid.parentElement, rootMargin: "200px" });

    // ---- 一覧 ----
    async function reload() {
        status.textContent = t("loading");
        try {
            items = (await api.get("/vps/api/poselib")).items;
        } catch (e) { status.textContent = e.message; return; }
        const keep = folderSel.value || pref("folder", "");
        const folders = [...new Set(items.map(i => i.folder))].sort();
        clear(folderSel).append(el("option", { value: "" }, `📁 ${t("plibAll")}`),
            ...folders.map(f => {
                const [src, ...rest] = f.split("/");
                return el("option", { value: f }, `📂 ${SOURCE_LABEL[src] ?? src}${rest.length ? " / " + rest.join("/") : ""}`);
            }));
        folderSel.value = folders.includes(keep) ? keep : "";
        render();
    }

    function filtered() {
        const q = search.value.trim().toLowerCase(), f = filterSel.value, folder = folderSel.value;
        return items.filter(i =>
            (!folder || i.folder === folder) &&
            (!q || i.name.toLowerCase().includes(q) || i.memo.toLowerCase().includes(q)) &&
            (f === "all" || (f === "favorite" ? i.favorite : i.ext === f)));
    }

    function render() {
        observer.disconnect();
        clear(grid);
        grid.style.setProperty("--plib-card", `${CARD_PX[sizeSel.value] ?? 140}px`);
        const a = actor();
        target.textContent = a ? `${t("plibTarget")}: ${a.name}` : t("plibNoActor");
        const list = filtered();
        if (!list.length) grid.append(el("div.vps-empty", items.length ? t("plibNoMatch") : t("plibEmpty")));
        for (const it of list) grid.append(card(it));
        status.textContent = t("plibCount", { n: list.length, all: items.length });
    }

    function card(it) {
        const thumb = el("div.vps-plib-thumb");
        const setImg = src => clear(thumb).append(el("img", { src, alt: "", onerror: () => clear(thumb).append(placeholder(it)) }));
        if (it.thumb) setImg(`${it.thumb}${it.thumb.includes("?") ? "&" : "?"}t=${Date.now()}`);
        else thumb.append(placeholder(it));
        const star = el("button.vps-plib-star", {
            title: t("plibFavorite"),
            onclick: async e => { e.stopPropagation(); await setMeta(it, { favorite: !it.favorite }); render(); },
        }, it.favorite ? "⭐" : "☆");
        const c = el("div.vps-plib-card", {
            title: `${it.name}${it.ext}${it.memo ? "\n" + it.memo : ""}`,
            onclick: () => apply(it, c),
            oncontextmenu: e => { e.preventDefault(); menu(e.clientX, e.clientY, it, setImg); },
        },
            thumb, star,
            it.ext === ".vrma" ? el("span.vps-plib-badge", { title: t("plibVrmaTip") }, "🎬") : null,
            el("div.vps-plib-info",
                el("div.vps-plib-name", it.name),
                el("div.vps-plib-sub",
                    el("span.vps-plib-ext", { style: { color: EXT_COLORS[it.ext] ?? "#9aa" } }, it.ext),
                    it.source !== "local" ? el("span.vps-plib-src", "3D PE") : null),
                it.memo ? el("div.vps-plib-memo", it.memo) : null,
            ),
        );
        if (!it.thumb) {
            c._onVisible = () => ensureThumb(it).then(ok => { if (ok && c.isConnected) setImg(`${it.thumb}?t=${Date.now()}`); });
            observer.observe(c);
        }
        return c;
    }

    const placeholder = it => el("div.vps-plib-ph", it.ext === ".vrma" ? "🎬" : "🧍");

    async function setMeta(it, patch) {
        await api.post("/vps/api/poselib/meta", { id: it.id, ...patch });
        Object.assign(it, patch);
    }

    // ---- 適用 ----
    async function apply(it, c, { mirror = false } = {}) {
        const a = actor();
        if (!a) { toast(t("plibNoActor"), "error"); return; }
        try {
            if (it.ext === ".vrma") {
                if (!(await confirmDialog(t("poseLibrary"), t("plibVrmaConfirm", { name: it.name, actor: a.name })))) return;
                await importMotion(studio, a, { name: `${it.name}${it.ext}`, url: it.url, ext: it.ext });
            } else {
                const parsed = await (await fetch(it.url)).json();
                if (!studio.applyPoseJson(a.id, parsed)) throw new Error(t("loadFailed"));
                if (mirror) studio.mirrorPose(a.id);
            }
            c?.classList.add("applied");
            setTimeout(() => c?.classList.remove("applied"), 700);
        } catch (e) { toast(`${it.name}: ${e.message}`, "error", 5000); }
    }

    async function saveCurrent() {
        const a = actor();
        if (!a) { toast(t("plibNoActor"), "error"); return; }
        const d = new Date(), pad = n => String(n).padStart(2, "0");
        const name = await promptText(t("plibSave"), `p_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
        if (!name) return;
        try {
            await api.savePose(name, a.exportPoseJson());
            folderSel.value = "local";
            setPref("folder", "local");
            await reload();
            toast(t("saved"), "success");
        } catch (e) { toast(e.message, "error"); }
    }

    // ---- 右クリックメニュー ----
    function menu(x, y, it, setImg) {
        document.getElementById("vps-plib-ctx")?.remove();
        const local = it.source === "local";
        const item = (label, fn, enabled = true) => el("button.vps-menu-item", {
            disabled: !enabled, onclick: () => { m.remove(); fn(); },
        }, label);
        const regen = back => async () => {
            const a = actor();
            if (!a) { toast(t("plibNoActor"), "error"); return; }
            thumbs ??= createThumbRenderer(a.src.url);
            const png = await thumbs.render(it, back);
            if (!png) { toast(t("loadFailed"), "error"); return; }
            await api.post(`/vps/api/poselib/thumb/${it.id}`, { image: png });
            it.thumb = `/vps/api/poselib/thumb/${it.id}`;
            setImg(`${it.thumb}?t=${Date.now()}`);
        };
        const m = el("div.vps-menu.vps-plib-ctx#vps-plib-ctx", { style: { position: "fixed", left: `${x}px`, top: `${y}px` } },
            item(it.favorite ? `⭐ ${t("plibUnfavorite")}` : `☆ ${t("plibFavorite")}`, async () => { await setMeta(it, { favorite: !it.favorite }); render(); }),
            it.ext !== ".vrma" ? item(`↔ ${t("plibMirrorApply")}`, () => apply(it, null, { mirror: true })) : null,
            item(`📝 ${t("plibMemo")}`, async () => {
                const v = await promptText(t("plibMemo"), it.memo);
                if (v === null || v === undefined) return;
                await setMeta(it, { memo: v.trim() }); render();
            }),
            item(`✏ ${t("plibRename")}`, async () => {
                const v = await promptText(t("plibRename"), it.name);
                if (!v || v === it.name) return;
                try { await api.post("/vps/api/poselib/rename", { kind: it.kind, path: it.path, new_name: v }); await reload(); }
                catch (e) { toast(e.message, "error"); }
            }, local),
            item(`🗑 ${t("delete")}`, async () => {
                if (!(await confirmDialog(t("delete"), `${it.name}${it.ext} — ${t("confirmDelete")}`, { danger: true, okLabel: t("delete") }))) return;
                try { await api.post("/vps/api/poselib/delete", { kind: it.kind, path: it.path }); await reload(); }
                catch (e) { toast(e.message, "error"); }
            }, local),
            item(`🖼 ${t("plibThumbFront")}`, regen(false)),
            item(`🖼 ${t("plibThumbBack")}`, regen(true)),
            local ? null : el("div.vps-hint.vps-plib-ro", t("plibReadOnly")),
        );
        document.body.append(m);
        // 画面からはみ出さないように寄せる
        const r = m.getBoundingClientRect();
        if (r.right > innerWidth) m.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
        if (r.bottom > innerHeight) m.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
        const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off, true); } };
        setTimeout(() => document.addEventListener("mousedown", off, true), 0);
    }

    folderSel.onchange = () => { setPref("folder", folderSel.value); render(); };
    filterSel.onchange = () => { setPref("filter", filterSel.value); render(); };
    sizeSel.onchange = () => { setPref("size", sizeSel.value); render(); };
    search.oninput = render;
    reload();
    return { close };
}

// ---------------------------------------------------------------- サムネイル
// VRM の読み込みと WebGL コンテキストの作成は最初の 1 回だけ。描画はキューで 1 件ずつ行う
// (同時に多数のコンテキストを作ると、ブラウザの上限を超えてメインのビューポートまで失われるため)
function createThumbRenderer(vrmUrl) {
    let ctxP = null, queue = Promise.resolve(), disposed = false;

    async function init() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = THUMB;
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(THUMB, THUMB, false);
        renderer.setClearColor(0x1c2030, 1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(1, 2, 2);
        scene.add(key);
        const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
        const actor = await Actor.load({ type: "actor", name: "thumbnail", src: { url: vrmUrl } });
        scene.add(actor.root);
        return { renderer, scene, camera, actor };
    }

    async function renderOne(item, back) {
        if (disposed) return null;
        ctxP ??= init();
        const ctx = await ctxP;
        if (disposed) return null;
        const { renderer, scene, camera, actor } = ctx;
        actor.resetPose();
        actor.setExpressions({});
        if (item.ext === ".vrma") {
            const { samples } = await actor.sampleVrma(item.url, 1);
            if (!samples?.length) return null;
            actor.setPose(samples[0].pose);
        } else {
            const parsed = await (await fetch(item.url)).json();
            if (!actor.importPoseJson(parsed)) return null;
        }
        actor.vrm.update(0);
        actor.resetPhysics();
        actor.root.updateMatrixWorld(true);
        // 全身が入るようにカメラを置く(rotateVRM0 済みなので VRM 0.x / 1.0 とも正面は +Z)
        const box = new THREE.Box3().setFromObject(actor.vrm.scene);
        const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
        const dist = (Math.max(size.x, size.y, size.z) / 2) / Math.tan(THREE.MathUtils.degToRad(15)) * 1.3;
        camera.position.set(center.x, center.y + size.y * 0.05, center.z + (back ? -dist : dist));
        camera.lookAt(center);
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
    }

    return {
        render(item, back = false) {
            const job = queue.then(() => renderOne(item, back)).catch(e => { console.warn("[VPS] thumbnail", e); return null; });
            queue = job;
            return job;
        },
        dispose() {
            disposed = true;
            queue.finally(async () => {
                const ctx = await ctxP?.catch(() => null);
                if (!ctx) return;
                ctx.actor.dispose();
                ctx.renderer.dispose();
                ctx.renderer.forceContextLoss();
            });
        },
    };
}
