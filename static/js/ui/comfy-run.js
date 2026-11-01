// comfy-run.js — ComfyUI へのプロンプト投入・完了待ち(生成タブ・リージョンタブで共用)

import { t } from "../i18n.js";

export const clientId = `vps-${Math.random().toString(36).slice(2)}`;

export const viewUrl = f => `/api/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" })}`;

// API 形式のプロンプトを投入して prompt_id を返す。拒否されたら最初のノードエラーを文にして投げる
export async function queuePrompt(prompt) {
    const res = await fetch("/api/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.prompt_id) {
        const ne = Object.entries(body.node_errors ?? {})[0];
        const detail = ne ? `#${ne[0]} ${ne[1].class_type}: ${ne[1].errors?.[0]?.message ?? ""} ${ne[1].errors?.[0]?.details ?? ""}` : body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`${t("genRejected")}: ${detail}`);
    }
    return body.prompt_id;
}

// 完了まで待って出力ファイル(images / gifs / videos)を返す。nodeIds を渡すとそのノードの出力だけ
export async function waitPrompt(promptId, onStatus, { nodeIds } = {}) {
    const t0 = Date.now();
    for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        const sec = Math.round((Date.now() - t0) / 1000);
        const hist = await (await fetch(`/api/history/${promptId}`)).json().catch(() => ({}));
        const entry = hist[promptId];
        if (!entry) {
            const q = await (await fetch("/api/queue")).json().catch(() => null);
            const pending = q?.queue_pending?.findIndex(x => x[1] === promptId) ?? -1;
            onStatus?.(pending >= 0 ? `${t("genQueued")} (${pending + 1}) · ${sec}s` : `${t("genRunning")} · ${sec}s`);
            continue;
        }
        if (entry.status?.status_str === "error") {
            const err = entry.status.messages?.find(m => m[0] === "execution_error")?.[1];
            throw new Error(`${t("genError")}: ${err?.node_type ?? ""} ${err?.exception_message ?? ""}`);
        }
        if (!entry.status?.completed) continue;
        const outs = [];
        for (const [id, o] of Object.entries(entry.outputs ?? {})) {
            if (nodeIds && !nodeIds.includes(id)) continue;
            for (const key of ["images", "gifs", "videos", "video"]) {
                for (const f of [].concat(o[key] ?? [])) if (f?.filename) outs.push(f);
            }
        }
        return { files: outs, sec };
    }
}

export async function interruptPrompt(promptId) {
    await fetch("/api/interrupt", { method: "POST" }).catch(() => {});
    if (promptId) await fetch("/api/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
}
