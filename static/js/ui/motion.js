// motion.js — モーション(VRMA / BVH / FBX)をキーフレームとして取り込む(インスペクタ・ドロップ共通)

import { t, getLang } from "../i18n.js";
import { el, toast, openModal, field } from "../util.js";
import { loadFbx } from "../lib/fbx_retarget.js";
import { peekBvh } from "../lib/bvh_retarget.js";
import { askBvhImportOptions } from "../lib/bvh_import_dialog.js";

// it: アセット({ name, url, ext })。every: 何フレームおきにキーを打つか
export async function importMotion(studio, actor, it, { every = 2 } = {}) {
    try {
        let n;
        if (it.ext === ".bvh") {
            const text = await (await fetch(it.url)).text();
            // 腰の移動・接地・平滑化・範囲などは 3D Pose Editor と同じ設定ダイアログで選ぶ
            const opts = await askBvhImportOptions(it.name, getLang(), peekBvh(text));
            if (!opts) return 0;
            toast(t("loading"));
            n = await studio.importBvh(actor.id, text, opts, { every });
        } else if (it.ext === ".fbx") {
            // Mixamo / MotionBuilder の骨名を VRM に当てはめる(lib/fbx_retarget.js)。テイクが複数あれば選ぶ
            toast(t("loading"), "info", 60000);
            const { asset, takes } = await loadFbx(it.url);
            toast(t("loading"), "info", 1);
            const opts = await askFbxTake(it.name, takes);
            if (!opts) return 0;
            n = await studio.importFbx(actor.id, asset, opts.take, { every, rootMotion: opts.rootMotion });
        } else {
            toast(t("loading"));
            // FBX は Mixamo / MotionBuilder の骨名を VRM に当てはめる(lib/fbx_retarget.js)
            n = await studio.importVrma(actor.id, it.url, { every });
        }
        toast(`${it.name}: ${n} keys`, "success");
        return n;
    } catch (e) {
        toast(`${t("loadFailed")}: ${e.message}`, "error", 6000);
        return 0;
    }
}

// FBX の取り込み設定: テイク(1 つならそれ)と、腰の移動を使うか。キャンセルで null
function askFbxTake(name, takes) {
    return new Promise(resolve => {
        const sel = el("select.vps-select", {}, takes.map(tk => el("option", { value: tk.index }, `${tk.name}  (${tk.duration.toFixed(1)}s)`)));
        const root = el("input", { type: "checkbox", checked: true });
        let done = false;
        const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
        const m = openModal(`🎞 ${name}`, el("div.vps-form-group",
            takes.length > 1 ? field(`${t("fbxTake")} (${takes.length})`, sel) : el("div.vps-hint", `${takes[0].name} (${takes[0].duration.toFixed(1)}s)`),
            el("label.vps-check", { title: t("fbxRootMotionHint") }, root, el("span", t("fbxRootMotion"))),
            el("div.vps-hint", t("fbxHint")),
        ), {
            onClose: () => finish(null),
            footer: [
                el("button.vps-btn", { onclick: () => finish(null) }, t("cancel")),
                el("button.vps-btn.primary", { onclick: () => finish({ take: +sel.value, rootMotion: root.checked }) }, t("fbxImport")),
            ],
        });
    });
}
