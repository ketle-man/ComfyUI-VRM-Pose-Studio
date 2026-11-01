// exporter.js — タイムラインを 1 フレームずつ決定論的に進めて PNG を撮り、サーバーへ送って動画化する
//
// 物理(揺れ物)は dt = 1/fps で順番に進めるので、何度書き出しても同じ結果になる。

import { api } from "../api.js";

const PREROLL_STEPS = 30; // 揺れ物を開始姿勢になじませるための空回し

// 現在フレームを書き出しと同じ条件(カットのカメラ・揺れ物はリセット)で撮る。サーバーには送らない。
// 戻り値 { color: Blob|null, mask: Blob|null }(PNG)。color: false でマスクだけ撮る
export async function captureFrame(studio, { width, height, mask = false, color: withColor = true } = {}) {
    const tl = studio.timeline;
    width ??= studio.output.width;
    height ??= studio.output.height;
    await studio._audioReady;
    const wasPlaying = studio.playing;
    if (wasPlaying) studio.play(false);
    const frame = Math.round(tl.current);
    studio.vp.pauseLoop(true);
    studio.vp.freeze(true);
    try {
        tl.current = frame;
        studio.applyFrame(frame, { render: true });
        for (const a of studio.actors()) a.resetPhysics();
        studio.applyFrame(frame, { render: true });
        await studio.env.seekVideo(frame / tl.fps);
        studio.vp.step(0);
        const color = withColor ? await studio.captureStill({ width, height }) : null;
        const m = mask ? await studio.captureStill({ width, height, mask: true }) : null;
        return { color, mask: m };
    } finally {
        studio.vp.pauseLoop(false);
        studio.seek(frame);
        studio.vp._render();
        studio.vp.freeze(false);
    }
}

export async function exportRender(studio, opts, { onProgress, signal } = {}) {
    const tl = studio.timeline;
    const fps = opts.fps ?? tl.fps;
    const start = opts.still ? Math.round(tl.current) : opts.start;
    const end = opts.still ? start : opts.end;  // end を含む
    const width = opts.width ?? studio.output.width;
    const height = opts.height ?? studio.output.height;
    const total = end - start + 1;

    const { name } = await api.post("/vps/api/renders", {
        name: opts.name, fps, width, height, frames: total, mask: !!opts.mask,
    });

    // リップシンク用の音声解析が終わってから撮る
    await studio._audioReady;

    const wasPlaying = studio.playing;
    if (wasPlaying) studio.play(false);
    const savedFrame = tl.current;
    studio.vp.pauseLoop(true);
    // 書き出し中はビューポートに画像を重ね、キャンバスの大きさの切り替えによる点滅を見せない
    studio.vp.freeze(true);
    const pending = new Set();
    const send = async (idx, blob, type) => {
        const p = api.putBlob(`/vps/api/renders/${encodeURIComponent(name)}/frame/${idx}?type=${type}`, blob);
        pending.add(p);
        p.finally(() => pending.delete(p));
        if (pending.size >= 6) await Promise.race(pending);
    };

    try {
        const dt = 1 / fps;
        // 書き出し fps がタイムラインと違うときは時刻で対応づける
        const frameAt = i => start + (i * tl.fps) / fps;
        const count = opts.still ? 1 : Math.max(1, Math.round(((end - start) * fps) / tl.fps) + 1);

        // 空回しも開始フレームの時刻で行う(風のゆらぎがタイムラインの時刻で決まるため)
        tl.current = frameAt(0);
        studio.applyFrame(frameAt(0), { render: true });
        for (const a of studio.actors()) a.resetPhysics();
        for (let i = 0; i < (opts.still ? 0 : PREROLL_STEPS); i++) studio.vp.step(dt);

        for (let i = 0; i < count; i++) {
            if (signal?.aborted) throw new DOMException("aborted", "AbortError");
            const f = frameAt(i);
            tl.current = f;
            studio.applyFrame(f, { render: true });
            await studio.env.seekVideo(f / tl.fps);
            if (!opts.still) studio.vp.step(dt);
            else studio.vp.step(0);
            const color = await studio.captureStill({ width, height });
            await send(i, color, "frame");
            if (opts.mask) {
                const mask = await studio.captureStill({ width, height, mask: true });
                await send(i, mask, "mask");
            }
            onProgress?.({ done: i + 1, total: count, phase: "render" });
        }
        await Promise.all(pending);
        onProgress?.({ done: count, total: count, phase: "encode" });
        const info = await api.post(`/vps/api/renders/${encodeURIComponent(name)}/finish`, {
            video: !opts.still && opts.video !== false,
            formats: opts.formats ?? ["mp4"],
            keep_frames: opts.keepFrames !== false,
            save_output: !!opts.saveOutput,
            transparent: studio.env.transparentBackground,
            audios: opts.withAudio
                ? studio.audios.filter(c => !c.muted && c.path && (c.volume ?? 1) > 0).map(c => ({ source: c.source, path: c.path, offset: (c.offset || 0) - start / tl.fps, trim: c.trim || 0, length: c.length ?? null, volume: c.volume ?? 1 }))
                : [],
        });
        // ComfyUI のタブ(VPS_LoadRender ノード)へ通知
        try { localStorage.setItem("vps:lastRender", JSON.stringify({ name, t: Date.now() })); } catch { /* ignore */ }
        return info;
    } catch (e) {
        if (e.name === "AbortError") await api.del(`/vps/api/renders/${encodeURIComponent(name)}`).catch(() => {});
        throw e;
    } finally {
        studio.vp.pauseLoop(false);
        studio.seek(savedFrame);
        studio.vp._render();
        studio.vp.freeze(false);
    }
}
