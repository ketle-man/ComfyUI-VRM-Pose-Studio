"""ポーズライブラリ(3D Pose Editor の Pose Library と同じ使い勝手)。

  GET  /vps/api/poselib                 ポーズ(.json / .vroidpose)とモーション(.vrma)の一覧
  POST /vps/api/poselib/meta            {id, favorite?, memo?} お気に入り・メモ
  GET  /vps/api/poselib/thumb/{id}      サムネイル PNG(?pe=<3D Pose Editor の id> でそちらを代わりに使う)
  POST /vps/api/poselib/thumb/{id}      {image: dataURL(PNG)} サムネイルを保存
  POST /vps/api/poselib/rename          {kind, path, new_name} 名前の変更(自前の assets/ のみ)
  POST /vps/api/poselib/delete          {kind, path} 削除(自前の assets/ のみ。メモ・サムネイルも消す)

・一覧の対象は アセット種別 poses / motions の全ソース(自前の assets/ と、3D Pose Editor の poses/)
・お気に入り・メモ・サムネイルは data/pose_library/ に保存する。3D Pose Editor の poses/ にあるものは、
  こちらに無ければ 3D Pose Editor の .pose_library/(メモ・お気に入り・サムネイル)を読み取り専用で使う
・id は "種別/ソース/相対パス" の md5。3D Pose Editor 側の id は poses/ からの相対パスの md5(同じ規則)
"""

import base64
import hashlib
import json
import re
from pathlib import Path

from aiohttp import web

from .config import ASSET_KINDS, ASSETS_DIR, DATA_DIR, POSE_EDITOR_DIR, asset_sources

STORE = DATA_DIR / "pose_library"
THUMBS = STORE / "thumbnails"
META_FILE = STORE / "metadata.json"
THUMBS.mkdir(parents=True, exist_ok=True)
PE_STORE = POSE_EDITOR_DIR / ".pose_library"

LIB_EXTS = {"poses": (".json", ".vroidpose"), "motions": (".vrma",)}
_ID_RE = re.compile(r"[0-9a-f]{32}")
_PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _md5(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _item_id(kind, source, rel):
    return _md5(f"{kind}/{source}/{rel}")


def _load_json(p: Path):
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_meta(meta):
    META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _err(msg, status=400):
    return web.json_response({"error": msg}, status=status)


def _resolve(base: Path, rel: str):
    try:
        p = (base / rel).resolve()
        p.relative_to(base.resolve())
        return p
    except (ValueError, OSError):
        return None


async def poselib_list(request):
    meta = _load_json(META_FILE)
    pe_meta = _load_json(PE_STORE / "metadata.json")
    items = []
    for kind, exts in LIB_EXTS.items():
        for source, base in asset_sources(kind):
            for p in sorted(base.rglob("*"), key=lambda x: x.as_posix().lower()):
                if not p.is_file() or p.suffix.lower() not in exts:
                    continue
                rel = p.relative_to(base).as_posix()
                if len(rel.split("/")) > 3:
                    continue
                fid = _item_id(kind, source, rel)
                m = meta.get(fid)
                pe_id = _md5(rel) if source == "pose-editor" else None
                if m is None and pe_id:
                    m = pe_meta.get(pe_id, {})
                m = m or {}
                thumb = None
                if (THUMBS / f"{fid}.png").exists():
                    thumb = f"/vps/api/poselib/thumb/{fid}"
                elif pe_id and (PE_STORE / "thumbnails" / f"{pe_id}.png").exists():
                    thumb = f"/vps/api/poselib/thumb/{fid}?pe={pe_id}"
                sub = str(Path(rel).parent.as_posix())
                items.append({
                    "id": fid, "kind": kind, "source": source, "path": rel,
                    "name": p.stem, "ext": p.suffix.lower(),
                    "folder": source if sub == "." else f"{source}/{sub}",
                    "url": f"/vps/api/assets/{kind}/{source}/{rel}",
                    "favorite": bool(m.get("favorite", False)), "memo": m.get("memo", ""),
                    "thumb": thumb, "mtime": p.stat().st_mtime,
                })
    return web.json_response({"items": items})


async def poselib_meta(request):
    try:
        body = await request.json()
    except Exception:
        return _err("invalid json")
    fid = str(body.get("id", ""))
    if not _ID_RE.fullmatch(fid):
        return _err("invalid id")
    meta = _load_json(META_FILE)
    entry = meta.setdefault(fid, {})
    # 3D Pose Editor 側から引き継いだ値も、ここで初めて自前の記録になる
    for key in ("favorite", "memo"):
        if key in body:
            entry[key] = bool(body[key]) if key == "favorite" else str(body[key])[:2000]
    _save_meta(meta)
    return web.json_response({"ok": True})


async def poselib_thumb_get(request):
    fid = request.match_info["id"]
    if not _ID_RE.fullmatch(fid):
        return _err("invalid id")
    own = THUMBS / f"{fid}.png"
    if own.exists():
        return web.FileResponse(own)
    pe = request.rel_url.query.get("pe", "")
    if _ID_RE.fullmatch(pe) and (PE_STORE / "thumbnails" / f"{pe}.png").exists():
        return web.FileResponse(PE_STORE / "thumbnails" / f"{pe}.png")
    return web.Response(status=404)


async def poselib_thumb_post(request):
    fid = request.match_info["id"]
    if not _ID_RE.fullmatch(fid):
        return _err("invalid id")
    try:
        data = (await request.json()).get("image", "")
        png = base64.b64decode(data.split(",", 1)[1] if "," in data else data)
    except Exception:
        return _err("invalid image")
    if not png.startswith(_PNG):
        return _err("image must be PNG")
    (THUMBS / f"{fid}.png").write_bytes(png)
    return web.json_response({"ok": True, "url": f"/vps/api/poselib/thumb/{fid}"})


def _local_target(body):
    kind = body.get("kind")
    if kind not in LIB_EXTS:
        return None, None, "invalid kind"
    rel = str(body.get("path", ""))
    p = _resolve(ASSETS_DIR / kind, rel)
    if p is None or not p.is_file() or p.suffix.lower() not in LIB_EXTS[kind]:
        return None, None, "not found"
    return kind, p, None


def _move_record(old_id, new_id):
    meta = _load_json(META_FILE)
    if old_id in meta:
        if new_id:
            meta[new_id] = meta.pop(old_id)
        else:
            meta.pop(old_id)
        _save_meta(meta)
    old_t = THUMBS / f"{old_id}.png"
    if old_t.exists():
        if new_id:
            old_t.replace(THUMBS / f"{new_id}.png")
        else:
            old_t.unlink()


async def poselib_rename(request):
    try:
        body = await request.json()
    except Exception:
        return _err("invalid json")
    kind, p, err = _local_target(body)
    if err:
        return _err(err, 404 if err == "not found" else 400)
    stem = _BAD.sub("", str(body.get("new_name", ""))).strip().strip(".")
    if not stem:
        return _err("invalid name")
    new = p.with_name(stem + p.suffix)
    if new.exists() and new != p:
        return _err("name already exists", 409)
    base = ASSETS_DIR / kind
    old_rel, new_rel = p.relative_to(base.resolve()).as_posix(), new.relative_to(base.resolve()).as_posix()
    p.rename(new)
    _move_record(_item_id(kind, "local", old_rel), _item_id(kind, "local", new_rel))
    return web.json_response({"ok": True, "path": new_rel})


async def poselib_delete(request):
    try:
        body = await request.json()
    except Exception:
        return _err("invalid json")
    kind, p, err = _local_target(body)
    if err:
        return _err(err, 404 if err == "not found" else 400)
    rel = p.relative_to((ASSETS_DIR / kind).resolve()).as_posix()
    p.unlink()
    _move_record(_item_id(kind, "local", rel), None)
    return web.json_response({"ok": True})


def setup_poselib_routes(r):
    assert set(LIB_EXTS) <= set(ASSET_KINDS)
    r.add_get("/vps/api/poselib", poselib_list)
    r.add_post("/vps/api/poselib/meta", poselib_meta)
    r.add_get("/vps/api/poselib/thumb/{id}", poselib_thumb_get)
    r.add_post("/vps/api/poselib/thumb/{id}", poselib_thumb_post)
    r.add_post("/vps/api/poselib/rename", poselib_rename)
    r.add_post("/vps/api/poselib/delete", poselib_delete)
