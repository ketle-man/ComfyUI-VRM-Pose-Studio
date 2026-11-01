// audio-panel.js — 左パネルの「音声」(A)と「音声 API」(S)。3D Pose Editor のポーズタブ A / S に相当
//
// ・A: 音声アセットの一覧。チェックした 1 件を音声トラックに置く / 試聴、チェックしたものを削除。
//      上部の「テキストから音声を作成」で TTS の音声を作り、そのまま音声トラックと口パクのセリフに使える
// ・S: 音声作成エンジン(Lemonade〈Kokoro〉/ VOICEVOX)の接続先と既定の声。3D Pose Editor と同じ設定ファイルを共有する

import { t } from "../i18n.js";
import { api } from "../api.js";
import { el, clear, toast, confirmDialog, fmtBytes, field } from "../util.js";

// Lemonade(Kokoro)で動作を確認済みの声(一覧を返す API が無いので固定)
const KOKORO_VOICES = ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "af_heart", "af_bella", "bf_emma"];

const listeners = new Set();
const notifyList = () => listeners.forEach(fn => fn());

// 音声を新しい音声トラックとして今の時刻に置き、足りなければタイムラインを伸ばす
export async function placeAudio(studio, it) {
    const tl = studio.timeline;
    const clip = await studio.addAudio({ url: it.url, name: it.name, source: it.source, path: it.path, offset: tl.current / tl.fps });
    const end = Math.ceil(((clip.offset || 0) + (clip.duration || 0)) * tl.fps);
    if (end > tl.frames) studio.setTimelineLength(end);
    return clip;
}

// テキストから音声を作る。actorId があれば、その人物の口パクを有効にし、セリフを同じ文に、口パクの音声をこのトラックにする
export async function createSpeech(studio, text, { voice, actorId, place = true } = {}) {
    text = (text || "").trim();
    if (!text) throw new Error(t("ttsEmpty"));
    const it = await api.post("/vps/api/tts/generate", { text, voice: voice || undefined });
    notifyList();
    const clip = place ? await placeAudio(studio, it) : null;
    if (actorId) studio.setLip(actorId, { enabled: true, text, ...(clip ? { audio: clip.id } : {}) });
    return it;
}

// ================================================================ A: 音声
export function buildAudioPanel(root, studio) {
    const text = el("textarea.vps-input.vps-textarea", { rows: 3, placeholder: t("ttsTextPh") });
    const toLip = el("input", { type: "checkbox", checked: true });
    const genBtn = el("button.vps-btn.small.primary", { onclick: () => generate() }, `🔊 ${t("ttsCreate")}`);
    const genStatus = el("div.vps-hint");

    const placeBtn = el("button.vps-btn.small", { title: t("audioPlaceTip"), onclick: () => placeChecked() }, `🎵 ${t("audioPlace")}`);
    const playBtn = el("button.vps-btn.small", { onclick: () => togglePlay() }, `▶ ${t("audioPreview")}`);
    const delBtn = el("button.vps-btn.small.danger", { onclick: () => deleteChecked() }, `🗑 ${t("delete")}`);
    const allBtn = el("button.vps-btn.small", { onclick: () => toggleAll() }, t("selectAll"));
    const upBtn = el("button.vps-btn.small", { title: t("audioUpload"), onclick: () => upload() }, "⬆");
    const refreshBtn = el("button.vps-btn.small", { title: t("refresh"), onclick: () => refresh() }, "↻");
    const tracksBox = el("div.vps-audio-tracks");
    const list = el("div.vps-audio-list");
    const status = el("div.vps-hint");

    root.append(
        el("div.vps-panel-title", `🎵 ${t("audioTab")}`),
        el("div.vps-audio-gen",
            el("div.vps-audio-sub", t("ttsTitle")),
            text,
            el("label.vps-check", toLip, el("span", t("ttsToLip"))),
            el("div.vps-btn-row", genBtn),
            genStatus,
        ),
        tracksBox,
        el("div.vps-audio-sub.vps-audio-files", t("audioFiles")),
        el("div.vps-audio-toolbar", placeBtn, playBtn, delBtn, allBtn, upBtn, refreshBtn),
        list, status,
    );

    let items = [];
    const checks = new Map();   // key → checkbox
    const keyOf = it => `${it.source}/${it.path}`;
    const checked = () => items.filter(it => checks.get(keyOf(it))?.checked);
    let preview = null, previewKey = null;

    function sync() {
        const n = checked().length;
        placeBtn.disabled = n !== 1;
        playBtn.disabled = n !== 1 && !preview;
        delBtn.disabled = !checked().some(it => it.source === "local");
        allBtn.disabled = !items.length;
        playBtn.textContent = preview ? `■ ${t("audioStop")}` : `▶ ${t("audioPreview")}`;
        const used = new Set(studio.audios.map(c => `${c.source ?? "local"}/${c.path}`));
        list.querySelectorAll(".vps-audio-row").forEach(r => r.classList.toggle("current", used.has(r.dataset.key)));
    }

    // 音声トラックの一覧(ミュート・音量・外す)。音量のドラッグ中に作り直さないよう、並びが変わったときだけ作り直す
    let tracksSig = null;
    function renderTracks() {
        // 分割したクリップは 1 つのトラックとして並べ、音量・ミュートはまとめて変える
        const tracks = studio.audioTracks();
        const sig = tracks.map(c => `${c.track}|${c.name}|${c.muted}|${c.clips.length}`).join(",");
        if (sig === tracksSig) return;
        tracksSig = sig;
        clear(tracksBox).append(el("div.vps-audio-sub", `${t("audioTracks")} (${tracks.length})`));
        if (!tracks.length) tracksBox.append(el("div.vps-hint", t("audioNoTracks")));
        for (const c of tracks) {
            const vol = el("input", {
                type: "range", min: 0, max: 100, step: 1, value: Math.round(c.volume * 100), title: t("audioVolume"),
                oninput: () => studio.setAudioTrackProps(c.track, { volume: +vol.value / 100 }),
            });
            const name = c.clips.length > 1 ? `${c.name} ✂${c.clips.length}` : c.name;
            tracksBox.append(el("div.vps-audio-track",
                el("button.vps-icon-btn", { title: t("audioMute"), onclick: () => studio.setAudioTrackProps(c.track, { muted: !c.muted }) }, c.muted ? "🔇" : "🔊"),
                el("span.vps-audio-name", { title: name }, name),
                vol,
                el("button.vps-icon-btn", { title: t("audioRemoveTrack"), onclick: () => studio.removeAudioTrack(c.track) }, "✕"),
            ));
        }
    }

    async function refresh() {
        status.textContent = t("loading");
        try {
            items = (await api.listAssets("audio")).sort((a, b) => b.mtime - a.mtime);
        } catch (e) {
            status.textContent = e.message;
            return;
        }
        const was = new Set([...checks].filter(([, c]) => c.checked).map(([k]) => k));
        clear(list);
        checks.clear();
        for (const it of items) {
            const c = el("input", { type: "checkbox", checked: was.has(keyOf(it)), onchange: sync });
            checks.set(keyOf(it), c);
            list.append(el("div.vps-audio-row", { dataset: { key: keyOf(it) }, title: it.path },
                c,
                el("span.vps-audio-name", { onclick: () => { c.checked = !c.checked; sync(); } }, it.name),
                it.source !== "local" ? el("span.vps-audio-src", { title: t("audioReadOnly") }, "3D PE") : null,
                el("span.vps-audio-size", fmtBytes(it.size)),
            ));
        }
        status.textContent = items.length ? t("audioCount", { n: items.length }) : t("audioEmpty");
        sync();
    }

    function stopPreview() {
        preview?.pause();
        preview = null; previewKey = null;
        sync();
    }

    function togglePlay() {
        if (preview) { stopPreview(); return; }
        const [it] = checked();
        if (!it) return;
        preview = new Audio(it.url);
        previewKey = keyOf(it);
        preview.addEventListener("ended", () => { if (previewKey === keyOf(it)) stopPreview(); });
        preview.play().catch(e => { toast(e.message, "error"); stopPreview(); });
        sync();
    }

    async function placeChecked() {
        const [it] = checked();
        if (!it) return;
        await placeAudio(studio, it);
        for (const c of checks.values()) c.checked = false;
        toast(`🎵 ${it.name}`, "success");
        sync();
    }

    async function deleteChecked() {
        const del = checked().filter(it => it.source === "local");
        if (!del.length) return;
        if (!(await confirmDialog(t("delete"), `${t("audioDeleteConfirm", { n: del.length })}\n\n${del.map(i => i.name).join("\n")}`, { danger: true, okLabel: t("delete") }))) return;
        for (const it of del) {
            try {
                await api.deleteAsset("audio", it.path);
                // このファイルを使っている音声トラックも外す
                for (const c of studio.audios.filter(c => c.path === it.path && (c.source ?? "local") === "local")) studio.removeAudio(c.id);
            } catch (e) { toast(`${it.name}: ${e.message}`, "error"); }
        }
        refresh();
    }

    function toggleAll() {
        const on = !items.every(it => checks.get(keyOf(it)).checked);
        for (const c of checks.values()) c.checked = on;
        sync();
    }

    async function upload() {
        const inp = el("input", { type: "file", accept: ".wav,.mp3,.ogg,.m4a,.flac" });
        inp.onchange = async () => {
            const f = inp.files[0];
            if (!f) return;
            try { await api.uploadAsset("audio", f); refresh(); } catch (e) { toast(e.message, "error"); }
        };
        inp.click();
    }

    async function generate() {
        const a = studio.selectedObject();
        const actorId = toLip.checked && a?.type === "actor" ? a.id : null;
        genBtn.disabled = true;
        genStatus.textContent = t("ttsWorking");
        try {
            const it = await createSpeech(studio, text.value, { actorId });
            genStatus.textContent = `✓ ${it.name}${actorId ? ` → ${a.name}` : ""}`;
        } catch (e) {
            genStatus.textContent = `✕ ${e.message}`;
        } finally {
            genBtn.disabled = false;
        }
    }

    listeners.add(refresh);
    studio.addEventListener("audios", () => { renderTracks(); sync(); });
    renderTracks();
    return { show: refresh };
}

// ================================================================ S: 音声 API
export function buildAudioSettings(root, studio) {
    const engine = el("select.vps-select", {}, el("option", { value: "lemonade" }, "Lemonade（Kokoro）"), el("option", { value: "voicevox" }, "VOICEVOX"));
    const lmUrl = el("input.vps-input", { placeholder: "http://127.0.0.1:13305" });
    const lmModel = el("input.vps-input", { placeholder: "kokoro-v1" });
    const lmVoice = el("select.vps-select");
    const vvUrl = el("input.vps-input", { placeholder: "http://127.0.0.1:50021" });
    const vvSpeaker = el("select.vps-select");
    const status = el("div.vps-hint.vps-pre");

    const setVoices = cur => {
        const names = !cur || KOKORO_VOICES.includes(cur) ? KOKORO_VOICES : [cur, ...KOKORO_VOICES];
        clear(lmVoice).append(...names.map(v => el("option", { value: v }, v + (v.startsWith("j") ? t("ttsJa") : t("ttsEn")))));
        lmVoice.value = cur || KOKORO_VOICES[0];
    };
    const setSpeakers = (speakers, cur) => {
        const list = !cur || speakers.some(s => s.id === cur) ? speakers : [{ id: cur, name: `ID ${cur}` }, ...speakers];
        clear(vvSpeaker).append(...list.map(s => el("option", { value: s.id }, s.name)));
        if (list.length) vvSpeaker.value = cur || list[0].id;
    };

    const lmBox = el("div.vps-audio-engine",
        field("Base URL", lmUrl), field("Model", lmModel), field(t("ttsDefaultVoice"), lmVoice));
    const vvBox = el("div.vps-audio-engine",
        field("Base URL", vvUrl), field(t("ttsDefaultVoice"), vvSpeaker),
        el("div.vps-btn-row", el("button.vps-btn.small", { onclick: () => reloadSpeakers() }, `↻ ${t("ttsSpeakers")}`)));
    const showEngine = () => { lmBox.hidden = engine.value !== "lemonade"; vvBox.hidden = engine.value !== "voicevox"; };
    engine.onchange = showEngine;

    root.append(
        el("div.vps-panel-title", `🔧 ${t("audioApiTab")}`),
        el("div.vps-audio-settings",
            field(t("ttsEngine"), engine), lmBox, vvBox,
            el("div.vps-btn-row",
                el("button.vps-btn.small.primary", { onclick: () => save() }, t("save")),
                el("button.vps-btn.small", { onclick: () => test() }, t("ttsTest"))),
            status,
            el("div.vps-hint", t("ttsSettingsHint")),
        ),
    );

    const fill = s => {
        engine.value = s.engine;
        lmUrl.value = s.lemonade.base_url; lmModel.value = s.lemonade.model; setVoices(s.lemonade.voice);
        vvUrl.value = s.voicevox.base_url;
        if (!vvSpeaker.options.length || ![...vvSpeaker.options].some(o => o.value === s.voicevox.speaker)) setSpeakers([], s.voicevox.speaker);
        vvSpeaker.value = s.voicevox.speaker;
        showEngine();
    };
    const body = () => ({
        engine: engine.value,
        lemonade: { base_url: lmUrl.value, model: lmModel.value, voice: lmVoice.value },
        voicevox: { base_url: vvUrl.value, speaker: vvSpeaker.value || "3" },
    });

    async function load() {
        try {
            const { settings } = await api.get("/vps/api/tts/settings");
            fill(settings);
            status.textContent = "";
            if (settings.engine === "voicevox") loadSpeakers(true);
        } catch (e) { status.textContent = e.message; }
    }
    async function save() {
        try { fill((await api.post("/vps/api/tts/settings", body())).settings); status.textContent = t("saved"); }
        catch (e) { status.textContent = `✕ ${e.message}`; }
    }
    async function loadSpeakers(quiet = false) {
        try {
            const { speakers } = await api.get("/vps/api/tts/speakers");
            setSpeakers(speakers, vvSpeaker.value);
            if (!quiet) status.textContent = t("ttsSpeakersLoaded", { n: speakers.length });
        } catch (e) { if (!quiet) status.textContent = `✕ ${e.message}`; }
    }
    // 接続先を変えた直後でも取れるよう、先に VOICEVOX の設定だけ保存してから取得する
    async function reloadSpeakers() {
        try { await api.post("/vps/api/tts/settings", { voicevox: body().voicevox }); }
        catch (e) { status.textContent = `✕ ${e.message}`; return; }
        loadSpeakers();
    }
    async function test() {
        status.textContent = t("ttsTesting");
        try {
            await api.post("/vps/api/tts/settings", body());
            const r = await api.get("/vps/api/tts/health");
            status.textContent = r.ok ? `✓ ${t("ttsTestOk")}（${r.engine} ${r.status}）` : `✕ ${r.error}`;
        } catch (e) { status.textContent = `✕ ${e.message}`; }
    }

    return { show: load };
}
