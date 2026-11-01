// inspector.js — 右パネル(選択中のオブジェクト / カメラ / 背景・ライトのプロパティ)

import * as THREE from "../../vendor/three.module.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { el, clear, slider, field, toast, promptText, downloadBlob } from "../util.js";
import { pickAsset } from "./assets.js";
import { importMotion } from "./motion.js";
import { createSpeech } from "./audio-panel.js";
import { SCENE_TRACK, WIND_TRACK } from "../engine/timeline.js";
import { confirmDialog } from "../util.js";

const RAD = Math.PI / 180;
const PRESET_EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised", "aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight"];

// 見出しごとの折りたたみ状態を、種類(人物・背景/ライト・カメラ…)ごとにこのブラウザに覚えておく。
// まだ触っていない見出しの既定: 人物は「ポーズ」だけ開き、他は閉じる。それ以外の種類は開く
const FOLD_KEY = "vps:sections";
let _fold = {};
try { _fold = JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch { /* ignore */ }
let _kind = "";   // いま組み立てているプロパティの種類(rebuild で設定)

function section(title, ...children) {
    const key = `${_kind}:${title}`;
    const collapsed = _fold[key] ?? (_kind === "actor" && title !== t("pose"));
    const body = el("div.vps-section-body", children);
    const head = el("div.vps-section-head", {
        onclick: () => {
            _fold[key] = s.classList.toggle("collapsed");
            try { localStorage.setItem(FOLD_KEY, JSON.stringify(_fold)); } catch { /* ignore */ }
        },
    }, title);
    const s = el(`div.vps-section${collapsed ? ".collapsed" : ""}`, head, body);
    return s;
}

function select(options, value, onChange) {
    const s = el("select.vps-select", { onchange: () => onChange(s.value) },
        options.map(([v, label]) => el("option", { value: v, selected: v === value }, label)));
    return s;
}

function checkbox(label, value, onChange) {
    const c = el("input", { type: "checkbox", checked: !!value, onchange: () => onChange(c.checked) });
    return el("label.vps-check", c, el("span", label));
}

function colorInput(value, onInput, onChange) {
    const c = el("input.vps-color", { type: "color", value });
    c.addEventListener("input", () => onInput(c.value));
    c.addEventListener("change", () => onChange?.(c.value));
    return c;
}

// x/y/z の 3 数値入力
function vec3(label, get, set, { step = 0.01, onChange } = {}) {
    const inputs = [0, 1, 2].map(i => el("input.vps-num", {
        type: "number", step,
        onchange: () => { set(inputs.map(n => +n.value)); onChange?.(); },
    }));
    const row = el("div.vps-field.vec3", el("span.vps-label", label), el("div.vps-vec3", inputs));
    row.refresh = () => { const v = get(); inputs.forEach((n, i) => { if (document.activeElement !== n) n.value = +v[i].toFixed(3); }); };
    row.refresh();
    return row;
}

export function buildInspector(root, studio) {
    let refreshers = [];
    const body = el("div.vps-inspector-body");
    root.append(el("div.vps-panel-title", t("inspector")), body);

    const rebuild = () => {
        clear(body);
        refreshers = [];
        const sel = studio.selection;
        if (!sel) { body.append(el("div.vps-empty", t("nothingSelected"))); return; }
        if (sel.id === "scene") { _kind = "scene"; return buildScene(); }
        if (sel.id === WIND_TRACK) { _kind = "wind"; return buildWind(); }
        if (studio.isCamera(sel.id)) { _kind = "camera"; return buildCamera(sel.id); }
        const obj = studio.get(sel.id);
        if (!obj) return;
        _kind = obj.type;
        buildObjectCommon(obj);
        if (obj.type === "actor") buildActor(obj, sel.bone);
        else if (obj.type === "light") buildLight(obj);
        else buildProp(obj);
    };

    const commit = () => studio.commitEdit();

    // ---------------------------------------------------------------- 共通
    function transformSection(o3d) {
        const e = new THREE.Euler();
        const pos = vec3(t("position"), () => o3d.position.toArray(), v => o3d.position.fromArray(v), { onChange: commit });
        const rot = vec3(t("rotation"), () => { e.setFromQuaternion(o3d.quaternion); return [e.x / RAD, e.y / RAD, e.z / RAD]; },
            v => o3d.quaternion.setFromEuler(e.set(v[0] * RAD, v[1] * RAD, v[2] * RAD)), { step: 1, onChange: commit });
        const scl = slider({
            label: t("uniformScale"), min: 0.05, max: 5, step: 0.01, value: o3d.scale.x,
            onInput: v => o3d.scale.setScalar(v), onChange: commit,
        });
        refreshers.push(pos.refresh, rot.refresh, () => scl.setValue(o3d.scale.x));
        return section(t("transform"), pos, rot, scl);
    }

    function buildObjectCommon(obj) {
        const name = el("input.vps-input", { value: obj.name, onchange: () => studio.rename(obj.id, name.value.trim() || obj.name) });
        body.append(el("div.vps-obj-head",
            name,
            el("div.vps-btn-row",
                el("button.vps-btn.small", { onclick: () => studio.vp.frameObject(obj.root) }, `🎯 ${t("frame")}`),
                el("button.vps-btn.small", { onclick: () => studio.duplicate(obj.id) }, `⧉ ${t("duplicate")}`),
                el("button.vps-btn.small.danger", { onclick: () => studio.removeObject(obj.id) }, `🗑 ${t("delete")}`),
            ),
        ));
        body.append(transformSection(obj.root));
    }

    // ---------------------------------------------------------------- 人物
    function buildActor(actor, boneName) {
        // 選択中のボーン
        const boneSec = [];
        if (boneName) {
            const b = actor.bone(boneName);
            const e = new THREE.Euler();
            const sliders = ["X", "Y", "Z"].map((axis, i) => slider({
                label: axis, min: -180, max: 180, step: 0.5, value: 0,
                onInput: v => {
                    e.setFromQuaternion(b.node.quaternion);
                    const arr = [e.x, e.y, e.z];
                    arr[i] = v * RAD;
                    b.node.quaternion.setFromEuler(e.set(...arr));
                },
                onChange: commit,
            }));
            const refresh = () => { e.setFromQuaternion(b.node.quaternion); [e.x, e.y, e.z].forEach((v, i) => sliders[i].setValue(+(v / RAD).toFixed(1))); };
            refresh();
            refreshers.push(refresh);
            boneSec.push(el("div.vps-bone-name", `🦴 ${boneName}`), ...sliders,
                el("div.vps-btn-row",
                    el("button.vps-btn.small", { onclick: () => studio.resetBone(actor.id, boneName) }, t("resetBone")),
                    el("button.vps-btn.small", { onclick: () => studio.select(actor.id) }, "✕"),
                ));
        } else {
            boneSec.push(el("div.vps-hint", t("noBone")));
        }

        const poseBtns = el("div.vps-btn-row",
            el("button.vps-btn.small", { onclick: () => studio.resetPose(actor.id) }, t("resetPose")),
            el("button.vps-btn.small", { onclick: () => studio.mirrorPose(actor.id) }, `↔ ${t("mirror")}`),
            el("button.vps-btn.small", {
                onclick: async () => {
                    const it = await pickAsset("poses", { title: t("loadPose") });
                    if (!it) return;
                    try {
                        const parsed = await api.get(it.url);
                        if (!studio.applyPoseJson(actor.id, typeof parsed === "string" ? JSON.parse(parsed) : parsed)) toast(t("loadFailed"), "error");
                    } catch (e) { toast(`${t("loadFailed")}: ${e.message}`, "error"); }
                },
            }, `📂 ${t("loadPose")}`),
            el("button.vps-btn.small", {
                onclick: async () => {
                    const n = await promptText(t("savePose"), `${actor.name}_pose`);
                    if (!n) return;
                    await api.savePose(n, actor.exportPoseJson());
                    toast(t("saved"), "success");
                },
            }, `💾 ${t("savePose")}`),
            el("button.vps-btn.small", {
                onclick: () => downloadBlob(new Blob([JSON.stringify(actor.exportPoseJson(), null, 2)], { type: "application/json" }), `${actor.name}_pose.json`),
            }, `⬇ ${t("downloadPose")}`),
        );

        const every = el("input.vps-num", { type: "number", min: 1, max: 30, value: 2 });
        const vrma = el("div.vps-btn-row",
            el("button.vps-btn.small", {
                onclick: async () => {
                    const it = await pickAsset("motions", { title: t("importVrma") });
                    if (it) await importMotion(studio, actor, it, { every: Math.max(1, +every.value || 1) });
                },
            }, `🎞 ${t("importVrma")}`),
            el("span.vps-label", t("vrmaEvery")), every,
        );

        body.append(section(t("pose"), ...boneSec, poseBtns, vrma,
            checkbox(t("springBone"), actor.springBone, v => { actor.springBone = v; commit(); }),
        ));

        // 視線(タイムラインの「目」トラック)。先にはカメラかシーンのオブジェクトを選ぶ
        const targets = [["", t("lookAtNone")], ["camera", `🎥 ${t("lookAtCameraOpt")}`],
            ...studio.list().filter(o => o !== actor).map(o => [o.id, o.name])];
        const lookAt = select(targets, actor.lookAtTarget, v => { actor.lookAtTarget = v; studio.editChannel(actor.id, "eyes"); });
        refreshers.push(() => { if (document.activeElement !== lookAt) lookAt.value = actor.lookAtTarget; });
        body.append(section(`👁 ${t("eyes")}`,
            field(t("lookAtTarget"), lookAt),
            el("div.vps-hint", t("lookAtHint")),
            el("div.vps-btn-row",
                el("button.vps-btn.small", { title: t("addLookAtMarkerTip"), onclick: () => studio.addLookAtMarker(actor.id, `🎯 ${actor.name}`) }, `🎯 ${t("addLookAtMarker")}`),
                el("button.vps-btn.small.primary", { onclick: () => studio.keyTrack(`${actor.id}#eyes`) }, `◆ ${t("keyEyes")}`)),
        ));

        // 表情
        const names = [...actor.expressionNames].sort((a, b) => {
            const ia = PRESET_EXPRESSIONS.indexOf(a), ib = PRESET_EXPRESSIONS.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
        });
        const expSliders = names.map(n => {
            const s = slider({ label: n, min: 0, max: 1, step: 0.01, value: actor.getExpression(n), onInput: v => actor.setExpression(n, v), onChange: commit });
            refreshers.push(() => s.setValue(actor.getExpression(n)));
            return s;
        });
        // 自動まばたき(表情 "blink" があるモデルだけ)
        const blinkItems = [];
        if (actor.hasBlink()) {
            const on = checkbox(`😑 ${t("autoBlink")}`, actor.blink.enabled, v => { actor.setBlink({ enabled: v }); studio.editChannel(actor.id, "blink"); });
            const iv = slider({ label: t("blinkInterval"), min: 0.5, max: 10, step: 0.5, value: actor.blink.interval, onInput: v => actor.setBlink({ interval: v }), onChange: () => studio.editChannel(actor.id, "blink") });
            refreshers.push(() => { on.querySelector("input").checked = actor.blink.enabled; iv.setValue(actor.blink.interval); });
            blinkItems.push(on, iv, el("div.vps-hint", t("blinkHint")));
        }
        if (expSliders.length) {
            const sec = section(t("expressions"), ...blinkItems, ...expSliders);
            body.append(sec);
        }

        // リップシンク
        const lip = actor.lip;
        const lipText = el("textarea.vps-input.vps-textarea", { rows: 3, placeholder: t("lipTextPh") });
        lipText.value = lip.text ?? "";
        lipText.addEventListener("change", () => studio.setLip(actor.id, { text: lipText.value }));
        const lipClip = studio.lipClip(actor);
        // オン・オフと口の開きはタイムラインの「口」トラックでキーにできる
        const lipOn = checkbox(t("lipEnable"), lip.enabled, v => { studio.setLip(actor.id, { enabled: v }); studio.editChannel(actor.id, "lip"); });
        const lipGain = slider({ label: t("lipGain"), min: 0.2, max: 5, step: 0.1, value: lip.gain ?? 1.5, onChange: v => { studio.setLip(actor.id, { gain: v }); studio.editChannel(actor.id, "lip"); } });
        refreshers.push(() => { lipOn.querySelector("input").checked = !!actor.lip.enabled; lipGain.setValue(actor.lip.gain ?? 1.5); });
        body.append(section(t("lipSync"),
            lipOn,
            field(t("lipAudio"), select([["", t("lipAudioAuto")], ...studio.audioTracks().map(c => [c.track, `🎵 ${c.name}`]), ["none", t("lipAudioNone")]],
                lip.audio && (lip.audio === "none" || studio.audios.some(c => c.track === lip.audio)) ? lip.audio : "", v => { studio.setLip(actor.id, { audio: v }); rebuild(); })),
            el("div.vps-hint", lipClip ? `🎵 ${lipClip.name}` : t("lipNoAudio")),
            field(t("lipVowels"), select([["auto", t("lipVowelsAuto")], ["audio", t("lipVowelsAudio")], ["text", t("lipVowelsText")], ["open", t("lipVowelsOpen")]],
                lip.vowels ?? "auto", v => studio.setLip(actor.id, { vowels: v }))),
            lipText,
            el("div.vps-btn-row", el("button.vps-btn.small", {
                title: t("ttsFromLipTip"),
                onclick: async e => {
                    const b = e.currentTarget;
                    b.disabled = true;
                    try { const it = await createSpeech(studio, lipText.value, { actorId: actor.id }); toast(`🔊 ${it.name}`, "success"); }
                    catch (err) { toast(err.message, "error", 6000); }
                    finally { b.disabled = false; }
                },
            }, `🔊 ${t("ttsFromLip")}`)),
            lipGain,
            el("div.vps-btn-row", el("button.vps-btn.small.primary", { onclick: () => studio.keyTrack(`${actor.id}#lip`) }, `◆ ${t("keyLip")}`)),
            el("div.vps-hint", t("lipHint")),
        ));
    }

    // ---------------------------------------------------------------- プロップ
    function buildProp(prop) {
        const items = [];
        if (prop.src.kind !== "gltf") {
            if (prop.src.kind === "primitive") {
                const color = colorInput(prop.color, v => { prop.color = v; prop.applyMaterial(); }, commit);
                refreshers.push(() => { if (document.activeElement !== color) color.value = prop.color; });
                items.push(field(t("color"), color));
            }
            const opacity = slider({ label: t("opacity"), min: 0, max: 1, step: 0.01, value: prop.opacity, onInput: v => { prop.opacity = v; prop.applyMaterial(); }, onChange: commit });
            refreshers.push(() => opacity.setValue(prop.opacity));
            items.push(opacity);
        }
        items.push(checkbox(t("castShadow"), prop.castShadow, v => { prop.castShadow = v; prop.applyMaterial(); commit(); }));
        body.append(section(t("addProp"), ...items));
        attachSection(prop);
    }

    // ---------------------------------------------------------------- ライト
    function buildLight(light) {
        const set = (k, v) => { light[k] = v; light.applyLight(); };
        // キーフレームで値が変わったらコントロールも追従させる
        const bind = (k, ctl) => { refreshers.push(() => ctl.setValue(light[k])); return ctl; };
        const color = colorInput(light.color, v => set("color", v), commit);
        refreshers.push(() => { if (document.activeElement !== color) color.value = light.color; });
        const items = [
            el("div.vps-hint", t("light_" + light.src.kind)),
            field(t("color"), color),
            bind("intensity", slider({ label: t("intensity"), min: 0, max: light.src.kind === "directional" ? 10 : 50, step: 0.1, value: light.intensity, onInput: v => set("intensity", v), onChange: commit })),
        ];
        if (light.src.kind !== "directional") {
            items.push(bind("distance", slider({ label: t("lightDistance"), min: 0, max: 30, step: 0.1, value: light.distance, onInput: v => set("distance", v), onChange: commit })));
        }
        if (light.src.kind === "spot") {
            items.push(
                bind("angle", slider({ label: t("spotAngle"), min: 1, max: 89, step: 1, value: light.angle, onInput: v => set("angle", v), onChange: commit })),
                bind("penumbra", slider({ label: t("spotPenumbra"), min: 0, max: 1, step: 0.01, value: light.penumbra, onInput: v => set("penumbra", v), onChange: commit })),
            );
        }
        items.push(checkbox(t("castShadow"), light.castShadow, v => { set("castShadow", v); commit(); }));
        if (light.src.kind !== "point") {
            items.push(el("div.vps-btn-row",
                el("button.vps-btn.small", { onclick: () => aimLight(light) }, `🎯 ${t("aimAtSubject")}`)));
        }
        items.push(el("div.vps-hint", t(light.src.kind === "point" ? "lightHintPoint" : "lightHint")));
        body.append(section(t("light"), ...items));
        attachSection(light);
    }

    // 選択中の人物(いなければ最初の人物、それもなければ原点)の胸へ向ける
    function aimLight(light) {
        const a = studio.actors()[0];
        const target = new THREE.Vector3(0, 1.1, 0);
        if (a) { a.root.getWorldPosition(target); target.y += 1.1 * a.root.scale.y; }
        // lookAt は親(アタッチ先のボーン)の回転も考慮してワールド座標の点へ向ける
        light.root.lookAt(target);
        commit();
        rebuild();
    }

    function attachSection(prop) {
        const actors = studio.actors();
        const ref = prop.parentRef;
        const actorSel = select([["", t("none")], ...actors.map(a => [a.id, a.name])], ref?.actorId ?? "", () => fillBones());
        const boneSel = el("select.vps-select");
        const fillBones = () => {
            clear(boneSel);
            const a = studio.get(actorSel.value);
            for (const b of a?.bones ?? []) boneSel.append(el("option", { value: b.name, selected: b.name === (ref?.bone ?? "rightHand") }, b.name));
        };
        fillBones();
        body.append(section(t("attach"),
            field(t("attachedTo"), actorSel),
            field(t("bone"), boneSel),
            el("div.vps-btn-row",
                el("button.vps-btn.small.primary", { onclick: () => { if (actorSel.value) studio.attach(prop.id, actorSel.value, boneSel.value); } }, `📎 ${t("attach")}`),
                ref ? el("button.vps-btn.small", { onclick: () => studio.detach(prop.id) }, t("detach")) : null,
            ),
        ));
    }

    // ---------------------------------------------------------------- カメラ

    function buildCamera(camId) {
        const cam = studio.cams.get(camId);
        const name = el("input.vps-input", { value: cam.name, onchange: () => studio.renameCamera(camId, name.value.trim() || cam.name) });
        const fov = slider({
            label: t("fov"), min: 5, max: 120, step: 0.5, value: cam.state.fov,
            onInput: v => studio.setCameraFov(camId, v),
            onChange: () => { if (studio.autoKey) studio.keyTrack(camId); studio.commitEdit(); },
        });
        refreshers.push(() => fov.setValue(studio.cams.get(camId)?.state.fov ?? 35));
        const isCut = studio.cutCameraAt() === camId;

        // 被写界深度
        const camCommit = () => { if (studio.autoKey) studio.keyTrack(camId); studio.commitEdit(); };
        const dof = () => studio.cams.get(camId)?.state.dof ?? {};
        const setDof = p => studio.setCameraDof(camId, p);
        const focusSel = select([["", t("dofManual")], ...studio.list().map(o => [o.id, o.name])], dof().focusOn ?? "", v => { setDof({ focusOn: v }); camCommit(); });
        const focus = slider({ label: t("dofFocus"), min: 0.1, max: 30, step: 0.05, value: dof().focus, onInput: v => setDof({ focus: v }), onChange: camCommit });
        const strength = slider({ label: t("dofStrength"), min: 0, max: 3, step: 0.05, value: dof().strength, onInput: v => setDof({ strength: v }), onChange: camCommit });
        const maxBlur = slider({ label: t("dofMaxBlur"), min: 0.1, max: 4, step: 0.05, value: dof().maxBlur, onInput: v => setDof({ maxBlur: v }), onChange: camCommit });
        const focusNow = el("div.vps-hint");
        const syncFocusNow = () => {
            const d = studio.currentFocusDistance(camId);
            focusNow.textContent = dof().focusOn && d != null ? `${t("dofFocusNow")}: ${d.toFixed(2)} m` : "";
        };
        refreshers.push(() => {
            const d = dof();
            focus.setValue(d.focus); strength.setValue(d.strength); maxBlur.setValue(d.maxBlur);
            focusSel.value = d.focusOn ?? ""; enabled.querySelector("input").checked = !!d.enabled;
            syncFocusNow();
        });
        const enabled = checkbox(t("dofEnable"), !!dof().enabled, v => { setDof({ enabled: v }); camCommit(); });
        syncFocusNow();
        body.append(
            el("div.vps-obj-head",
                el("div.vps-obj-title", el("span.vps-cam-dot", { style: { background: cam.color } }), ` 🎥 ${t("camera")}`),
                name,
                el("div.vps-btn-row",
                    el("button.vps-btn.small", { onclick: () => studio.addCamera() }, `＋ ${t("camFromView")}`),
                    studio.cams.list().length > 1 ? el("button.vps-btn.small.danger", {
                        onclick: async () => {
                            if (await confirmDialog(t("delete"), `${cam.name} — ${t("confirmDelete")}`, { danger: true, okLabel: t("delete") })) studio.removeCamera(camId);
                        },
                    }, `🗑 ${t("delete")}`) : null,
                ),
            ),
            section(t("camera"), fov,
                el("div.vps-btn-row",
                    studio.monitor
                        ? el("button.vps-btn.small", { title: t("camFromMonitorTip"), onclick: () => studio.cameraFromMonitor(camId) }, `🖥→🎥 ${t("camFromMonitor")}`)
                        : el("button.vps-btn.small", { onclick: () => { studio.vp.resetCamera(); studio.commitEdit(); } }, t("resetCamera")),
                    el("button.vps-btn.small.primary", { onclick: () => studio.keyTrack(camId) }, `◆ ${t("keyCamera")}`),
                ),
                el("div.vps-hint", t(studio.monitor ? "camMonitorHint" : "camEditHint")),
            ),
            section(t("dof"), enabled, field(t("dofFocusOn"), focusSel), focusNow, focus, strength, maxBlur, el("div.vps-hint", t("dofHint"))),
            section(t("cut"),
                el("div.vps-btn-row",
                    el("button.vps-btn.small.primary", { onclick: () => studio.setCut(camId) }, `🎬 ${t("cutHere")}`),
                    el("span.vps-hint", isCut ? `✔ ${t("cutActive")}` : ""),
                ),
                el("div.vps-hint", t("cutHint")),
            ),
        );
    }

    // ---------------------------------------------------------------- 背景・ライト
    // 風の設定(背景・ライトの中と、風を選んだときの両方で使う)
    function windItems() {
        const w = studio.env.state.wind;
        const set = patch => studio.setEnv({ wind: patch });
        const az = slider({ label: t("windFrom"), min: -180, max: 360, step: 1, value: w.azimuth, onInput: v => set({ azimuth: v }) });
        const elv = slider({ label: t("elevation"), min: -60, max: 60, step: 1, value: w.elevation, onInput: v => set({ elevation: v }) });
        // ギズモでつまみを動かしている間も数値を追う
        refreshers.push(() => { az.setValue(w.azimuth); elv.setValue(w.elevation); });
        return [
            checkbox(t("windEnable"), w.enabled, v => set({ enabled: v })),
            slider({ label: t("windStrength"), min: 0, max: 5, step: 0.05, value: w.strength, onInput: v => set({ strength: v }) }),
            az, elv,
            slider({ label: t("windTurbulence"), min: 0, max: 1, step: 0.01, value: w.turbulence, onInput: v => set({ turbulence: v }) }),
            el("div.vps-btn-row", el("button.vps-btn.small.primary", { onclick: () => studio.keyTrack(WIND_TRACK) }, `◆ ${t("keyWind")}`)),
            el("div.vps-hint", t("windHint")),
            el("div.vps-hint", t("windMoveHint")),
        ];
    }

    function buildWind() {
        body.append(el("div.vps-obj-head", el("div.vps-obj-title", `🌬 ${t("wind")}`)), section(t("wind"), ...windItems()));
    }

    function buildScene() {
        const st = studio.env.state;
        const set = patch => studio.setEnv(patch);
        const bg = st.background;

        const bgItems = [field(t("background"), select(
            [["color", t("bgColor")], ["image", t("bgImage")], ["video", t("bgVideo")], ["transparent", t("bgTransparent")]],
            bg.mode,
            async mode => {
                if ((mode === "image" || mode === "video") && !(bg.mode === mode && bg.url)) {
                    const it = await pickAsset("backgrounds", {
                        title: t("background"),
                        filter: i => (mode === "video" ? [".mp4", ".webm", ".mov"] : [".png", ".jpg", ".jpeg", ".webp"]).includes(i.ext),
                    });
                    if (!it) { rebuild(); return; }
                    await set({ background: { mode, url: it.url, name: it.name } });
                } else await set({ background: { mode } });
                rebuild();
            }))];
        if (bg.mode === "color") bgItems.push(field(t("color"), colorInput(bg.color, v => set({ background: { color: v } }))));
        if (bg.mode === "image" || bg.mode === "video") {
            bgItems.push(el("div.vps-btn-row", el("span.vps-file-name", bg.name ?? ""),
                el("button.vps-btn.small", {
                    onclick: async () => {
                        const it = await pickAsset("backgrounds", { title: t("background"), filter: i => (bg.mode === "video" ? [".mp4", ".webm", ".mov"] : [".png", ".jpg", ".jpeg", ".webp"]).includes(i.ext) });
                        if (it) { await set({ background: { url: it.url, name: it.name } }); rebuild(); }
                    },
                }, t("chooseFile"))));
            bgItems.push(field(t("fit"), select([["cover", t("cover")], ["contain", t("contain")]], bg.fit ?? "cover", v => set({ background: { fit: v } }))));
        }
        if (bg.mode === "video") {
            bgItems.push(slider({ label: t("videoOffset"), min: -60, max: 60, step: 0.04, value: bg.offset ?? 0, onInput: v => set({ background: { offset: v } }), onChange: () => studio.seek(studio.timeline.current) }));
            bgItems.push(checkbox(t("loop"), bg.loop, v => set({ background: { loop: v } })));
        }

        const light = (key, label, extra = []) => section(label,
            field(t("color"), colorInput(st[key].color, v => set({ [key]: { color: v } }))),
            slider({ label: t("intensity"), min: 0, max: 8, step: 0.05, value: st[key].intensity, onInput: v => set({ [key]: { intensity: v } }) }),
            slider({ label: t("azimuth"), min: -180, max: 360, step: 1, value: st[key].azimuth, onInput: v => set({ [key]: { azimuth: v } }) }),
            slider({ label: t("elevation"), min: -10, max: 90, step: 1, value: st[key].elevation, onInput: v => set({ [key]: { elevation: v } }) }),
            ...extra,
        );

        body.append(
            el("div.vps-obj-head",
                el("div.vps-obj-title", `🌄 ${t("scene")}`),
                el("div.vps-btn-row",
                    el("button.vps-btn.small.primary", { onclick: () => studio.keyTrack(SCENE_TRACK) }, `◆ ${t("keyScene")}`),
                    el("span.vps-hint", t("keySceneHint")),
                ),
            ),
            section(t("background"), ...bgItems),
            section(t("ground"),
                checkbox(t("visible"), st.ground.visible, v => set({ ground: { visible: v } })),
                checkbox(t("shadowOnly"), st.ground.shadowOnly, v => set({ ground: { shadowOnly: v } })),
                field(t("color"), colorInput(st.ground.color, v => set({ ground: { color: v } }))),
                checkbox(t("grid"), st.grid, v => set({ grid: v })),
            ),
            section(t("ambient"),
                field(t("skyColor"), colorInput(st.ambient.color, v => set({ ambient: { color: v } }))),
                field(t("groundColor"), colorInput(st.ambient.ground, v => set({ ambient: { ground: v } }))),
                slider({ label: t("intensity"), min: 0, max: 5, step: 0.05, value: st.ambient.intensity, onInput: v => set({ ambient: { intensity: v } }) }),
            ),
            light("key", t("keyLight"), [checkbox(t("shadow"), st.key.shadow, v => set({ key: { shadow: v } }))]),
            light("rim", t("rimLight")),
            section(t("wind"), ...windItems()),
            section(t("toneMapping"),
                checkbox(t("toneMapping"), st.toneMapping, v => set({ toneMapping: v })),
                slider({ label: t("exposure"), min: 0.1, max: 3, step: 0.05, value: st.exposure, onInput: v => set({ exposure: v }) }),
            ),
        );
    }

    studio.addEventListener("selection", rebuild);
    studio.addEventListener("audios", () => { if (studio.selectedObject()?.type === "actor") rebuild(); });
    studio.addEventListener("objects", () => {
        // 名前の変更などでフォーカス中の入力が消えないよう、編集中は作り直さない
        if (!body.contains(document.activeElement)) rebuild();
    });
    studio.addEventListener("edited", () => refreshers.forEach(f => f()));
    studio.addEventListener("env", () => { if ([SCENE_TRACK, WIND_TRACK].includes(studio.selection?.id) && !body.contains(document.activeElement)) rebuild(); });
    rebuild();
}

