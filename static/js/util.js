// util.js — DOM ヘルパー・トースト・モーダル

// el("div.cls#id", {attrs / on*: handler}, children...)
export function el(spec, attrs = {}, ...children) {
    const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const node = document.createElement(m?.[1] || "div");
    for (const part of (m?.[2] || "").match(/[.#][\w-]+/g) ?? []) {
        if (part[0] === ".") node.classList.add(part.slice(1));
        else node.id = part.slice(1);
    }
    if (attrs instanceof Node || typeof attrs === "string" || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k in node && typeof v !== "string") node[k] = v;
        else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

export function clear(node) { while (node.firstChild) node.firstChild.remove(); return node; }

let _toastTimer = null;
export function toast(msg, type = "info", ms = 3000) {
    const t = document.getElementById("vps-toast");
    if (!t) return;
    clearTimeout(_toastTimer);
    t.textContent = msg;
    t.className = `vps-toast show ${type}`;
    _toastTimer = setTimeout(() => (t.className = "vps-toast"), ms);
}

// モーダル。戻り値の close() で閉じる。onClose はどの閉じ方でも呼ばれる
export function openModal(title, body, { wide = false, onClose, footer } = {}) {
    const overlay = el("div.vps-modal-overlay");
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
    const onKey = e => { if (e.key === "Escape") close(); };
    const box = el(`div.vps-modal${wide ? ".wide" : ""}`,
        el("div.vps-modal-head", el("span.vps-modal-title", title), el("button.vps-icon-btn", { title: "Close", onclick: close }, "✕")),
        el("div.vps-modal-body", body),
        footer ? el("div.vps-modal-foot", footer) : null,
    );
    overlay.append(box);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    return { close, box };
}

export function promptText(title, value = "", { okLabel = "OK" } = {}) {
    return new Promise(resolve => {
        const input = el("input.vps-input", { type: "text", value });
        let done = false;
        const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
        const m = openModal(title, input, {
            onClose: () => finish(null),
            footer: [el("button.vps-btn", { onclick: () => finish(null) }, "Cancel"), el("button.vps-btn.primary", { onclick: () => finish(input.value.trim() || null) }, okLabel)],
        });
        input.addEventListener("keydown", e => { if (e.key === "Enter") finish(input.value.trim() || null); });
        setTimeout(() => { input.focus(); input.select(); }, 0);
    });
}

export function confirmDialog(title, message, { okLabel = "OK", danger = false } = {}) {
    return new Promise(resolve => {
        let done = false;
        const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
        const m = openModal(title, el("p", message), {
            onClose: () => finish(false),
            footer: [el("button.vps-btn", { onclick: () => finish(false) }, "Cancel"), el(`button.vps-btn.${danger ? "danger" : "primary"}`, { onclick: () => finish(true) }, okLabel)],
        });
    });
}

export function pickFile(accept, multiple = false) {
    return new Promise(resolve => {
        const input = el("input", { type: "file", accept, multiple, style: { display: "none" } });
        input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
        document.body.append(input);
        input.click();
    });
}

export function downloadBlob(blob, filename) {
    const a = el("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

// 数値スライダー + 数値入力。onInput は連続、onChange は確定時(履歴・オートキー用)
export function slider({ label, min, max, step = 0.01, value, onInput, onChange, fmt }) {
    const num = el("input.vps-num", { type: "number", min, max, step, value: +(+value).toFixed(4) });
    const rng = el("input.vps-range", { type: "range", min, max, step, value });
    const set = (v, src) => {
        if (src !== num) num.value = +(+v).toFixed(4);
        if (src !== rng) rng.value = v;
    };
    rng.addEventListener("input", () => { set(rng.value, rng); onInput?.(+rng.value); });
    rng.addEventListener("change", () => onChange?.(+rng.value));
    num.addEventListener("change", () => { set(num.value, num); onInput?.(+num.value); onChange?.(+num.value); });
    const row = el("label.vps-field", el("span.vps-label", label), rng, num);
    row.setValue = v => set(v);
    if (fmt) num.title = fmt(value);
    return row;
}

export function field(label, control) {
    return el("label.vps-field", el("span.vps-label", label), control);
}
