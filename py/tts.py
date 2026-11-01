"""テキストから音声を作成(TTS)と、その API 設定。3D Pose Editor の pose_audio_server.py と同じ仕組み。

  GET/POST /vps/api/tts/settings   API 設定(エンジン・接続先・既定の声)
  GET      /vps/api/tts/health     選択中のエンジンへの接続テスト
  GET      /vps/api/tts/speakers   VOICEVOX の話者(スタイル)一覧
  POST     /vps/api/tts/generate   {text, voice?} → assets/audio/tts_*.wav|mp3 に保存し、アセット項目を返す

・設定は 3D Pose Editor と同じ <output>/vrm_pose_editor/api_settings.json を読み書きする(一度の設定で両方から使える)
・Lemonade(OpenAI 互換 /api/v1/audio/speech、Kokoro)/ VOICEVOX(/audio_query → /synthesis)
・接続先はこの PC(ループバック)だけに限る(SSRF 対策)。上流の応答本文は利用者へ返さずログに残す
"""

import asyncio
import http.client
import ipaddress
import json
import logging
import re
import urllib.parse
from datetime import datetime

from aiohttp import web

from .config import ASSETS_DIR, POSE_EDITOR_OUT

log = logging.getLogger("VRMPoseStudio.tts")

MAX_TEXT_LEN = 2000
MAX_SETTING_LEN = 200
DEFAULT_LEMONADE = {"base_url": "http://127.0.0.1:13305", "model": "kokoro-v1", "voice": "jf_alpha"}
DEFAULT_VOICEVOX = {"base_url": "http://127.0.0.1:50021", "speaker": "3"}
ENGINES = ("lemonade", "voicevox")


def _settings_path():
    POSE_EDITOR_OUT.mkdir(parents=True, exist_ok=True)
    return POSE_EDITOR_OUT / "api_settings.json"


def _base_url_error(url: str):
    """接続先 URL の検証。問題なければ None、あれば理由を返す"""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return "base_url は http:// か https:// で始めてください"
    if parts.username or parts.password or parts.query or parts.fragment:
        return "base_url にユーザー情報・クエリ・フラグメントは含められません"
    host = parts.hostname or ""
    if host.lower() == "localhost":
        return None
    try:
        if ipaddress.ip_address(host).is_loopback:
            return None
    except ValueError:
        pass
    return "接続先はこの PC（localhost / 127.0.0.1 / ::1）のみ指定できます"


def _load_settings() -> dict:
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    result = {"engine": data.get("engine") if data.get("engine") in ENGINES else "lemonade"}
    for name, defaults in (("lemonade", DEFAULT_LEMONADE), ("voicevox", DEFAULT_VOICEVOX)):
        cfg = dict(defaults)
        saved = data.get(name)
        if isinstance(saved, dict):
            for key in defaults:
                if isinstance(saved.get(key), str) and saved[key].strip():
                    cfg[key] = saved[key].strip()
        result[name] = cfg
    return result


def _http_request(url, method="GET", body=None, headers=None, timeout=180):
    """この PC では Python からループバックへの接続が不定期に切れる(WinError 10054)ことがあるので、
    切断のときだけ最大 2 回やり直す(どの呼び出しも何度送っても結果が同じ)"""
    for attempt in range(3):
        try:
            return _http_request_once(url, method, body, headers, timeout)
        except (ConnectionResetError, ConnectionAbortedError):
            if attempt == 2:
                raise
            log.info("connection reset, retrying: %s", url)


def _http_request_once(url, method, body, headers, timeout):
    """urllib は "Connection: close" を付け、Lemonade が返送中に接続を切るため http.client を使う"""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname, parts.port, timeout=timeout)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        conn.request(method, path, body=body, headers=headers or {})
        res = conn.getresponse()
        return res.status, res.read()
    finally:
        conn.close()


def _call_lemonade(cfg, text, voice) -> bytes:
    url = cfg["base_url"].rstrip("/") + "/api/v1/audio/speech"
    payload = json.dumps({"model": cfg["model"], "input": text, "voice": voice}, ensure_ascii=False).encode("utf-8")
    status, data = _http_request(url, "POST", payload, {"Content-Type": "application/json; charset=utf-8",
                                                        "Content-Length": str(len(payload))})
    if status != 200:
        log.warning("Lemonade speech failed: HTTP %s %s", status, data.decode("utf-8", "replace")[:300])
        raise RuntimeError(f"HTTP {status}")
    if not data:
        raise RuntimeError("empty audio")
    return data


def _call_voicevox(cfg, text, speaker) -> bytes:
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode({"text": text, "speaker": speaker})
    status, query = _http_request(base + "/audio_query?" + q, "POST", b"", {"Content-Length": "0"}, timeout=60)
    if status != 200:
        log.warning("VOICEVOX audio_query failed: HTTP %s %s", status, query.decode("utf-8", "replace")[:300])
        raise RuntimeError(f"HTTP {status}")
    status, wav = _http_request(base + "/synthesis?" + urllib.parse.urlencode({"speaker": speaker}), "POST", query,
                                {"Content-Type": "application/json", "Content-Length": str(len(query))})
    if status != 200:
        log.warning("VOICEVOX synthesis failed: HTTP %s %s", status, wav.decode("utf-8", "replace")[:300])
        raise RuntimeError(f"HTTP {status}")
    if not wav:
        raise RuntimeError("empty audio")
    return wav


def _err(msg, status=400):
    return web.json_response({"error": msg}, status=status)


async def tts_settings_get(request):
    return web.json_response({"settings": _load_settings()})


async def tts_settings_post(request):
    try:
        body = await request.json()
    except Exception:
        return _err("invalid json")
    if not isinstance(body, dict):
        return _err("設定が不正です")
    current = _load_settings()
    if "engine" in body:
        if body["engine"] not in ENGINES:
            return _err("engine が不正です")
        current["engine"] = body["engine"]
    for name, defaults in (("lemonade", DEFAULT_LEMONADE), ("voicevox", DEFAULT_VOICEVOX)):
        incoming = body.get(name)
        if incoming is None:
            continue
        if not isinstance(incoming, dict):
            return _err(f"{name} の設定が不正です")
        cleaned = {}
        for key in defaults:
            value = str(incoming.get(key, "")).strip()
            if not value or len(value) > MAX_SETTING_LEN:
                return _err(f"{name}.{key} が空、または長すぎます")
            cleaned[key] = value
        err = _base_url_error(cleaned["base_url"])
        if err:
            return _err(err)
        cleaned["base_url"] = cleaned["base_url"].rstrip("/")
        if name == "voicevox" and not cleaned["speaker"].isdigit():
            return _err("speaker は数字の話者 ID で指定してください")
        current[name] = cleaned
    _settings_path().write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return web.json_response({"settings": current})


async def tts_health(request):
    settings = _load_settings()
    engine = settings["engine"]
    cfg = settings[engine]
    err = _base_url_error(cfg["base_url"])
    if err:
        return web.json_response({"ok": False, "error": err})
    url = cfg["base_url"].rstrip("/") + ("/version" if engine == "voicevox" else "/api/v1/health")
    try:
        status, _ = await asyncio.to_thread(_http_request, url, "GET", None, None, 5)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
    except Exception:  # noqa: BLE001
        log.exception("%s health check failed", engine)
        return web.json_response({"ok": False, "error": "接続できませんでした（エンジンが起動しているか確認してください）"})
    return web.json_response({"ok": True, "engine": engine, "status": f"HTTP {status}"})


async def tts_speakers(request):
    cfg = _load_settings()["voicevox"]
    err = _base_url_error(cfg["base_url"])
    if err:
        return _err(err)
    try:
        status, data = await asyncio.to_thread(_http_request, cfg["base_url"].rstrip("/") + "/speakers", "GET", None, None, 10)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        speakers = [{"id": str(st["id"]), "name": f"{sp['name']}（{st['name']}）"}
                    for sp in json.loads(data) for st in sp.get("styles", [])]
    except Exception:  # noqa: BLE001
        log.exception("VOICEVOX speakers fetch failed")
        return _err("話者一覧を取得できませんでした", 502)
    return web.json_response({"speakers": speakers})


async def tts_generate(request, asset_item):
    try:
        body = await request.json()
    except Exception:
        return _err("invalid json")
    text = str(body.get("text", "")).strip()
    if not text:
        return _err("テキストが空です")
    if len(text) > MAX_TEXT_LEN:
        return _err(f"テキストは {MAX_TEXT_LEN} 文字以内にしてください")
    settings = _load_settings()
    engine = settings["engine"]
    cfg = settings[engine]
    err = _base_url_error(cfg["base_url"])
    if err:
        return _err(err)
    if engine == "voicevox":
        voice = str(body.get("voice") or cfg["speaker"]).strip() or cfg["speaker"]
        if not voice.isdigit():
            return _err("VOICEVOX の話者 ID は数字で指定してください")
        tag, ext, call = f"vv{voice}", "wav", _call_voicevox
    else:
        voice = str(body.get("voice") or cfg["voice"]).strip() or cfg["voice"]
        tag = re.sub(r"[^A-Za-z0-9_\-]", "", voice)[:32] or "voice"
        ext, call = "mp3", _call_lemonade
    try:
        audio = await asyncio.to_thread(call, cfg, text, voice)
    except Exception:  # noqa: BLE001
        log.exception("%s speech generation failed", engine)
        return _err("音声の作成に失敗しました（エンジンが起動しているか、サーバーのログを確認してください）", 502)

    out_dir = ASSETS_DIR / "audio"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"tts_{stamp}_{tag}.{ext}"
    n = 1
    while (out_dir / name).exists():
        name = f"tts_{stamp}_{tag}_{n}.{ext}"
        n += 1
    (out_dir / name).write_bytes(audio)
    return web.json_response(asset_item("audio", "local", out_dir, out_dir / name))


def setup_tts_routes(r, asset_item):
    r.add_get("/vps/api/tts/settings", tts_settings_get)
    r.add_post("/vps/api/tts/settings", tts_settings_post)
    r.add_get("/vps/api/tts/health", tts_health)
    r.add_get("/vps/api/tts/speakers", tts_speakers)

    async def generate(request):
        return await tts_generate(request, asset_item)

    r.add_post("/vps/api/tts/generate", generate)
