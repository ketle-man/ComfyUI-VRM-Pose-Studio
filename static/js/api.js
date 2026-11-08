// api.js — サーバー API の薄いラッパー

// サーバーのエラー本文 {error, code?, params?} を Error にする(code / params は画面側の翻訳用)
function apiError(body, fallback) {
    const e = new Error(body?.error || fallback);
    if (body?.code) { e.code = body.code; e.params = body.params ?? {}; }
    return e;
}

async function handle(res) {
    if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch { /* not json */ }
        throw apiError(body, `HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
}

export const api = {
    get: (url) => fetch(url).then(handle),
    post: (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(handle),
    del: (url) => fetch(url, { method: "DELETE" }).then(handle),
    putBlob: (url, blob) => fetch(url, { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob }).then(handle),

    listAssets: (kind) => api.get(`/vps/api/assets/${kind}`).then(r => r.items),
    uploadAsset(kind, file, onProgress) {
        // 大きな動画もあるので XHR で進捗を出す
        return new Promise((resolve, reject) => {
            const fd = new FormData();
            fd.append("file", file, file.name);
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `/vps/api/assets/${kind}`);
            xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
            xhr.onload = () => {
                let body = null;
                try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
                if (xhr.status >= 200 && xhr.status < 300) resolve(body);
                else reject(apiError(body, `HTTP ${xhr.status}`));
            };
            xhr.onerror = () => reject(new Error("network error"));
            xhr.send(fd);
        });
    },
    deleteAsset: (kind, path) => api.del(`/vps/api/assets/${kind}/local/${path.split("/").map(encodeURIComponent).join("/")}`),
    savePose: (name, data) => api.post("/vps/api/poses", { name, data }),

    listProjects: () => api.get("/vps/api/projects").then(r => r.items),
    getProject: (name) => api.get(`/vps/api/projects/${encodeURIComponent(name)}`),
    saveProject: (name, project, thumbnail) => api.post(`/vps/api/projects/${encodeURIComponent(name)}`, { project, thumbnail }),
    deleteProject: (name) => api.del(`/vps/api/projects/${encodeURIComponent(name)}`),

    listRenders: () => api.get("/vps/api/renders").then(r => r.items),
    deleteRender: (name) => api.del(`/vps/api/renders/${encodeURIComponent(name)}`),

    getSettings: () => api.get("/vps/api/settings"),
    saveSettings: (s) => api.post("/vps/api/settings", s),
};

export function blobToDataURL(blob) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(blob);
    });
}

// ファイル拡張子 → アセット種別
export function kindForFile(name) {
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "vrm") return "models";
    if (["glb", "gltf"].includes(ext)) return "props";
    if (["mp4", "webm", "mov"].includes(ext)) return "backgrounds";
    if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "backgrounds";
    if (["json", "vroidpose"].includes(ext)) return "poses";
    if (["wav", "mp3", "ogg", "m4a", "flac"].includes(ext)) return "audio";
    if (["vrma", "bvh", "fbx"].includes(ext)) return "motions";
    return null;
}
