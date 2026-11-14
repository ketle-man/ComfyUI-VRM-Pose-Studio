"""VRM Pose Studio の HTTP ルート。

ComfyUI の PromptServer.instance.app にも、開発用の素の aiohttp アプリ(dev_server.py)にも
同じ setup_routes(app) で登録できるよう、PromptServer には依存しない。

  GET    /vps                                   SPA 本体
  GET    /vps_static/...                        静的ファイル
  GET    /vps/api/assets/{kind}                 アセット一覧(models/props/backgrounds/poses/audio/motions)
  GET    /vps/api/assets/{kind}/{source}/{path} アセットファイル(.gltf の相対リソースも解決できるパス形式)
  POST   /vps/api/assets/{kind}                 アップロード(multipart: file)
  DELETE /vps/api/assets/{kind}/local/{path}    削除(自前 assets/ のみ)
  POST   /vps/api/poses                         ポーズ JSON を保存 {name, data}
  GET/POST/DELETE /vps/api/projects[/{name}]    プロジェクト
  GET/POST /vps/api/renders ...                 書き出し(フレーム受信 → ffmpeg で動画化)
  GET/POST /vps/api/settings                    SPA 設定
  GET    /vps/api/workflows[/{name}]            同梱のサンプルワークフロー(example_workflows/)
  /vps/api/tts/...                              テキストから音声を作成(py/tts.py)
  /vps/api/poselib/...                          ポーズライブラリ(py/pose_library.py)
"""

import asyncio
import base64
import json
import logging
import re
import shutil
import subprocess
import time
from pathlib import Path

from aiohttp import web

from .config import (
    ASSET_KINDS, ASSETS_DIR, DATA_DIR, PROJECTS_DIR, RENDERS_DIR, ROOT_DIR, STATIC_DIR, STUDIO_OUT, TEMPLATES_DIR,
    asset_sources, is_safe_rel,
)
from .tts import setup_tts_routes
from .pose_library import setup_poselib_routes

logger = logging.getLogger("VRMPoseStudio")

SETTINGS_FILE = DATA_DIR / "settings.json"
_BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
MAX_UPLOAD = 2 * 1024 ** 3  # 2GB(動画背景を想定)


def safe_name(name, fallback="untitled"):
    """ファイル名として安全な文字列にする(日本語は残す)。"""
    s = _BAD_CHARS.sub("_", str(name or "")).strip().strip(".")
    return s[:120] or fallback


def unique_path(directory: Path, filename: str) -> Path:
    p = directory / filename
    stem, ext = p.stem, p.suffix
    i = 1
    while p.exists():
        p = directory / f"{stem}_{i}{ext}"
        i += 1
    return p


def resolve_under(base: Path, rel: str):
    """base 配下に収まるときだけ解決済みパスを返す(パストラバーサル対策)。

    UNC・ドライブ指定・絶対パス・「..」は is_safe_rel で結合・resolve() の前に
    文字列のまま拒否する(Windows では UNC を resolve() するだけで相手ホストへ接続するため)。
    """
    if not is_safe_rel(rel):
        return None
    try:
        target = (base / rel).resolve()
        target.relative_to(base.resolve())
        return target
    except (ValueError, OSError):
        return None


def _json_error(msg, status=400):
    return web.json_response({"error": msg}, status=status)


# ---------------------------------------------------------------- page

async def index_page(request):
    return web.FileResponse(TEMPLATES_DIR / "index.html", headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------- assets

def _asset_item(kind, source, base: Path, p: Path):
    rel = p.relative_to(base).as_posix()
    return {
        "name": p.name,
        "path": rel,
        "source": source,
        "ext": p.suffix.lower(),
        "size": p.stat().st_size,
        "mtime": p.stat().st_mtime,
        "url": f"/vps/api/assets/{kind}/{source}/{rel}",
    }


async def list_assets(request):
    kind = request.match_info["kind"]
    if kind not in ASSET_KINDS:
        return _json_error("unknown kind", 404)
    exts = ASSET_KINDS[kind]
    items = []
    for source, d in asset_sources(kind):
        # サブフォルダ1階層まで(VRMA_MotionPack/vrma/*.vrma のような配布物も拾えるよう rglob)
        for p in sorted(d.rglob("*"), key=lambda x: x.as_posix().lower()):
            if p.is_file() and p.suffix.lower() in exts and len(p.relative_to(d).parts) <= 3:
                items.append(_asset_item(kind, source, d, p))
    return web.json_response({"items": items})


async def get_asset_file(request):
    kind = request.match_info["kind"]
    source = request.match_info["source"]
    base = dict(asset_sources(kind)).get(source) if kind in ASSET_KINDS else None
    if base is None:
        return web.Response(status=404)
    target = resolve_under(base, request.match_info["path"])
    if target is None:
        return web.Response(status=403)
    if not target.is_file():
        return web.Response(status=404)
    return web.FileResponse(target)


async def upload_asset(request):
    kind = request.match_info["kind"]
    if kind not in ASSET_KINDS:
        return _json_error("unknown kind", 404)
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "file":
        field = await reader.next()
    if field is None or not field.filename:
        return _json_error("file field is required")
    filename = safe_name(Path(field.filename).name)
    if Path(filename).suffix.lower() not in ASSET_KINDS[kind]:
        return _json_error(f"unsupported file type for {kind}: {filename}")
    base = ASSETS_DIR / kind
    target = unique_path(base, filename)
    size = 0
    try:
        with open(target, "wb") as f:
            while True:
                chunk = await field.read_chunk(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise ValueError("file too large")
                f.write(chunk)
    except Exception as e:
        target.unlink(missing_ok=True)
        return _json_error(str(e))
    return web.json_response(_asset_item(kind, "local", base, target))


async def delete_asset(request):
    kind = request.match_info["kind"]
    if kind not in ASSET_KINDS:
        return web.Response(status=404)
    target = resolve_under(ASSETS_DIR / kind, request.match_info["path"])
    if target is None or not target.is_file():
        return web.Response(status=404)
    target.unlink()
    return web.json_response({"ok": True})


async def save_pose(request):
    body = await request.json()
    name = safe_name(body.get("name"), "pose")
    data = body.get("data")
    if not isinstance(data, dict):
        return _json_error("data must be an object")
    base = ASSETS_DIR / "poses"
    target = base / f"{name}.json"
    if target.exists() and not body.get("overwrite"):
        target = unique_path(base, f"{name}.json")
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return web.json_response(_asset_item("poses", "local", base, target))


# ---------------------------------------------------------------- projects

def _project_path(name):
    return PROJECTS_DIR / f"{safe_name(name)}.json"


async def list_projects(request):
    items = []
    for p in sorted(PROJECTS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        thumb = p.with_suffix(".png")
        items.append({
            "name": p.stem,
            "mtime": p.stat().st_mtime,
            "thumb": f"/vps/api/projects/{p.stem}/thumb?t={int(thumb.stat().st_mtime)}" if thumb.exists() else None,
        })
    return web.json_response({"items": items})


async def get_project(request):
    p = _project_path(request.match_info["name"])
    if not p.is_file():
        return web.Response(status=404)
    return web.Response(text=p.read_text(encoding="utf-8"), content_type="application/json")


async def get_project_thumb(request):
    p = _project_path(request.match_info["name"]).with_suffix(".png")
    if not p.is_file():
        return web.Response(status=404)
    return web.FileResponse(p)


def _decode_data_url(s):
    if not s or "," not in s:
        return None
    try:
        return base64.b64decode(s.split(",", 1)[1])
    except Exception:
        return None


async def save_project(request):
    name = safe_name(request.match_info["name"])
    body = await request.json()
    project = body.get("project")
    if not isinstance(project, dict):
        return _json_error("project must be an object")
    p = _project_path(name)
    p.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
    thumb = _decode_data_url(body.get("thumbnail"))
    if thumb and thumb[:4] == b"\x89PNG":
        p.with_suffix(".png").write_bytes(thumb)
    return web.json_response({"ok": True, "name": name})


async def delete_project(request):
    p = _project_path(request.match_info["name"])
    p.unlink(missing_ok=True)
    p.with_suffix(".png").unlink(missing_ok=True)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------- renders

def _render_dir(name):
    d = resolve_under(RENDERS_DIR, safe_name(name))
    return d if d is not None and d.parent == RENDERS_DIR.resolve() else None


def _read_meta(d: Path):
    try:
        return json.loads((d / "meta.json").read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_meta(d: Path, meta):
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _render_info(d: Path, meta):
    files = {p.name for p in d.iterdir()}
    base = f"/vps/api/renders/{d.name}"
    stamp = int(meta.get("finished", 0))
    # 形式ごとのファイル(mp4 / webm / gif)。プレビューは MP4 → WebM → GIF の順に、あるものを使う
    videos = {f: f"{base}/file/video.{f}?t={stamp}" for f in VIDEO_FORMATS if f"video.{f}" in files}
    return {
        **meta,
        "name": d.name,
        "thumb": f"{base}/file/frame_00000.png" if "frame_00000.png" in files
                 else f"{base}/file/thumb.png" if "thumb.png" in files else None,
        "video": videos.get("mp4") or videos.get("webm"),
        "videos": videos,
        "frames_saved": sum(1 for f in files if f.startswith("frame_")),
    }


async def list_renders(request):
    items = []
    for d in RENDERS_DIR.iterdir():
        if d.is_dir():
            meta = _read_meta(d)
            if meta:
                items.append(_render_info(d, meta))
    items.sort(key=lambda m: m.get("created", 0), reverse=True)
    return web.json_response({"items": items})


async def create_render(request):
    body = await request.json()
    base = safe_name(body.get("name") or time.strftime("render_%Y%m%d_%H%M%S"))
    d = RENDERS_DIR / base
    i = 1
    while d.exists():
        d = RENDERS_DIR / f"{base}_{i}"
        i += 1
    d.mkdir(parents=True)
    meta = {
        "fps": float(body.get("fps", 24)),
        "width": int(body.get("width", 1024)),
        "height": int(body.get("height", 1024)),
        "frames": int(body.get("frames", 1)),
        "mask": bool(body.get("mask", True)),
        "created": time.time(),
        "status": "rendering",
    }
    _write_meta(d, meta)
    return web.json_response({"name": d.name})


async def put_render_frame(request):
    d = _render_dir(request.match_info["name"])
    if d is None or not d.is_dir():
        return web.Response(status=404)
    idx = int(request.match_info["idx"])
    kind = request.query.get("type", "frame")
    if kind not in ("frame", "mask") or not 0 <= idx < 100000:
        return _json_error("bad frame")
    data = await request.read()
    if data[:4] != b"\x89PNG":
        return _json_error("PNG expected")
    (d / f"{kind}_{idx:05d}.png").write_bytes(data)
    return web.json_response({"ok": True})


def _ffmpeg_exe():
    try:
        import imageio_ffmpeg  # type: ignore
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def _audio_file(spec):
    if not isinstance(spec, dict):
        return None
    base = dict(asset_sources("audio")).get(spec.get("source", "local"))
    if base is None:
        return None
    p = resolve_under(base, spec.get("path", ""))
    return p if p is not None and p.is_file() else None


VIDEO_FORMATS = ("mp4", "webm", "gif")
GIF_MAX = 480  # GIF は色数の制限とファイルの大きさのため、長辺をこの大きさまでに縮める(3D Pose Editor と同じ)


def _audio_tracks(body):
    """書き出しに重ねる音声 [(ファイル, 開始秒, 音量, ファイル内の開始秒, 長さ秒 or None)]。旧形式の audio(1 本)も受け付ける"""
    specs = body.get("audios")
    if not isinstance(specs, list):
        specs = [body["audio"]] if isinstance(body.get("audio"), dict) else []
    tracks = []
    for spec in specs:
        f = _audio_file(spec)
        if not f:
            continue
        off = float(spec.get("offset", 0) or 0)
        trim = max(0.0, float(spec.get("trim", 0) or 0))
        length = spec.get("length")
        length = max(0.0, float(length)) if length is not None else None
        # 書き出し範囲より前に始まるクリップは、はみ出した分を頭から切る
        if off < 0:
            trim -= off
            length = None if length is None else length + off
            off = 0.0
        if length is not None and length <= 0.001:
            continue
        tracks.append((f, off, max(0.0, min(4.0, float(spec.get("volume", 1) or 0))), trim, length))
    return tracks


def _video_cmd(exe, d: Path, fps, fmt, tracks, transparent, frames):
    """連番 PNG(+ 音声)から fmt の動画を作る ffmpeg のコマンド。
    長さは -t で「フレーム数 / fps」に固定する(apad + -shortest だけでは音声のぶん長くなることがあった)"""
    dur = ["-t", f"{frames / float(fps):.3f}"]
    out = d / f"video.{fmt}"
    cmd = [exe, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(d / "frame_%05d.png")]
    if fmt == "gif":
        # パレットを作ってから減色する(透明背景なら透明色を 1 つ残す)。ループ再生
        scale = f"scale='if(gte(iw,ih),min({GIF_MAX},iw),-2)':'if(gte(iw,ih),-2,min({GIF_MAX},ih))':flags=lanczos"
        pal = "palettegen=reserve_transparent=1:stats_mode=diff" if transparent else "palettegen=stats_mode=diff"
        use = "paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=4" if transparent else "paletteuse=dither=bayer:bayer_scale=4"
        return cmd + ["-filter_complex", f"[0:v]{scale},split[a][b];[a]{pal}[p];[b][p]{use}", "-loop", "0", *dur, str(out)]
    for f, *_ in tracks:
        cmd += ["-i", str(f)]
    if fmt == "webm":
        # VP9。透明背景ならアルファ付き(yuva420p)
        cmd += ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p" if transparent else "yuv420p", "-b:v", "0", "-crf", "30", "-row-mt", "1"]
    else:
        cmd += ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"]
    if tracks:
        # 使う範囲を切り出し(atrim)、開始位置へずらし(adelay)、音量を掛けて重ねる。apad で無音を足し、長さは映像に合わせる(-shortest)
        parts = []
        for i, (_, off, vol, trim, length) in enumerate(tracks):
            cut = f"atrim=start={trim:.3f}" + (f":duration={length:.3f}" if length is not None else "") + ",asetpts=PTS-STARTPTS"
            parts.append(f"[{i + 1}:a]{cut},adelay=delays={int(round(off * 1000))}:all=1,volume={vol:.3f}[a{i}]")
        mix = "".join(f"[a{i}]" for i in range(len(tracks)))
        mix += f"amix=inputs={len(tracks)}:normalize=0:dropout_transition=0," if len(tracks) > 1 else ""
        parts.append(f"{mix}apad[aout]")
        acodec = ["-c:a", "libopus", "-b:a", "160k"] if fmt == "webm" else ["-c:a", "aac", "-b:a", "192k"]
        cmd += ["-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[aout]", *acodec, "-shortest"]
    return cmd + [*dur, str(out)]


def _copy_to_output(d: Path, fmt):
    """「Save to ComfyUI output」: output/vrm_pose_studio/<書き出し名>.<fmt> にコピーする(同名があれば _1, _2…)"""
    STUDIO_OUT.mkdir(parents=True, exist_ok=True)
    dst = unique_path(STUDIO_OUT, f"{d.name}.{fmt}")
    shutil.copyfile(d / f"video.{fmt}", dst)
    return {"format": fmt, "filename": dst.name, "subfolder": STUDIO_OUT.name, "type": "output"}


async def finish_render(request):
    d = _render_dir(request.match_info["name"])
    if d is None or not d.is_dir():
        return web.Response(status=404)
    meta = _read_meta(d) or {}
    body = await request.json() if request.can_read_body else {}
    frames = sorted(d.glob("frame_*.png"))
    meta["frames"] = len(frames)
    meta["status"] = "done"
    meta["finished"] = time.time()
    # 作る形式(既定は従来どおり MP4 だけ)
    formats = [f for f in (body.get("formats") or ["mp4"]) if f in VIDEO_FORMATS]
    errors = {}
    outputs = []
    if body.get("video", True) and len(frames) > 1 and formats:
        exe = _ffmpeg_exe()
        if not exe:
            errors = {f: "ffmpeg not found (pip install imageio-ffmpeg)" for f in formats}
        else:
            tracks = _audio_tracks(body)
            for fmt in formats:
                cmd = _video_cmd(exe, d, meta.get("fps", 24), fmt, tracks, bool(body.get("transparent")), len(frames))
                # asyncio.create_subprocess_exec は Windows の ComfyUI(SelectorEventLoop)では NotImplementedError になるので、
                # 別スレッドで subprocess.run を使う(3D Pose Editor と同じ)
                try:
                    proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True)
                    rc, err = proc.returncode, proc.stderr
                except Exception as e:  # noqa: BLE001 — 失敗は形式ごとのエラーとして返す
                    rc, err = -1, str(e).encode()
                if rc != 0 or not (d / f"video.{fmt}").is_file():
                    errors[fmt] = err.decode(errors="replace")[-800:]
                    logger.warning("VRM Pose Studio: ffmpeg (%s) failed: %s", fmt, errors[fmt])
                elif body.get("save_output"):
                    outputs.append(await asyncio.to_thread(_copy_to_output, d, fmt))
    meta["formats"] = [f for f in formats if f not in errors and (d / f"video.{f}").is_file()]
    # 動画のみ(keep_frames: false): 動画が 1 つでもできたら、1 枚目をサムネイルに残して連番 PNG(とマスク)を消す。
    # 全部失敗したときは作業を失わないよう残す
    if body.get("keep_frames") is False and meta["formats"]:
        if frames:
            shutil.copyfile(frames[0], d / "thumb.png")
        for p in [*d.glob("frame_*.png"), *d.glob("mask_*.png")]:
            p.unlink(missing_ok=True)
        meta["video_only"] = True
        meta["mask"] = False
    meta.pop("video_error", None)
    if errors:
        meta["video_error"] = "\n".join(f"{f.upper()}: {e}" for f, e in errors.items())
    _write_meta(d, meta)
    return web.json_response({**_render_info(d, meta), "outputs": outputs})


async def get_render_file(request):
    d = _render_dir(request.match_info["name"])
    if d is None:
        return web.Response(status=404)
    p = resolve_under(d, request.match_info["file"])
    if p is None or not p.is_file():
        return web.Response(status=404)
    return web.FileResponse(p)


async def delete_render(request):
    d = _render_dir(request.match_info["name"])
    if d is None or not d.is_dir():
        return web.Response(status=404)
    shutil.rmtree(d)
    return web.json_response({"ok": True})


# ---------------------------------------------------------------- settings

async def get_settings(request):
    try:
        return web.json_response(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except Exception:
        return web.json_response({})


async def save_settings(request):
    body = await request.json()
    if not isinstance(body, dict):
        return _json_error("object expected")
    SETTINGS_FILE.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return web.json_response(body)


# ---------------------------------------------------------------- サンプルワークフロー

WORKFLOWS_DIR = ROOT_DIR / "example_workflows"


def _workflow_names():
    return sorted(p.name for p in WORKFLOWS_DIR.glob("*.json") if p.is_file()) if WORKFLOWS_DIR.is_dir() else []


async def list_workflows(request):
    return web.json_response({"items": _workflow_names()})


async def get_workflow(request):
    # 一覧にある名前だけ返す(Windows では "D:x.json" のようなドライブ付きの名前を結合するとフォルダの外を指すため、
    # 文字の検査ではなく実在する一覧との照合にする)
    name = request.match_info["name"]
    if name not in _workflow_names():
        return _json_error("not found", 404)
    return web.FileResponse(WORKFLOWS_DIR / name)


# ---------------------------------------------------------------- setup

def setup_routes(app):
    r = app.router
    r.add_get("/vps", index_page)
    r.add_static("/vps_static", str(STATIC_DIR))
    r.add_get("/vps/api/assets/{kind}", list_assets)
    r.add_post("/vps/api/assets/{kind}", upload_asset)
    r.add_get("/vps/api/assets/{kind}/{source}/{path:.+}", get_asset_file)
    r.add_delete("/vps/api/assets/{kind}/local/{path:.+}", delete_asset)
    r.add_post("/vps/api/poses", save_pose)
    r.add_get("/vps/api/projects", list_projects)
    r.add_get("/vps/api/projects/{name}", get_project)
    r.add_get("/vps/api/projects/{name}/thumb", get_project_thumb)
    r.add_post("/vps/api/projects/{name}", save_project)
    r.add_delete("/vps/api/projects/{name}", delete_project)
    r.add_get("/vps/api/renders", list_renders)
    r.add_post("/vps/api/renders", create_render)
    r.add_put("/vps/api/renders/{name}/frame/{idx}", put_render_frame)
    r.add_post("/vps/api/renders/{name}/finish", finish_render)
    r.add_get("/vps/api/renders/{name}/file/{file:.+}", get_render_file)
    r.add_delete("/vps/api/renders/{name}", delete_render)
    r.add_get("/vps/api/settings", get_settings)
    r.add_post("/vps/api/settings", save_settings)
    r.add_get("/vps/api/workflows", list_workflows)
    r.add_get("/vps/api/workflows/{name}", get_workflow)
    setup_tts_routes(r, _asset_item)
    setup_poselib_routes(r)
