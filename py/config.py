"""パス設定。ComfyUI 本体が無い環境(dev_server.py)でも import できるようにする。"""

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
TEMPLATES_DIR = ROOT_DIR / "templates"
ASSETS_DIR = ROOT_DIR / "assets"
DATA_DIR = ROOT_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"

# アセット種別 → 受け付ける拡張子
ASSET_KINDS = {
    "models":      (".vrm",),
    "props":       (".glb", ".gltf", ".vrm", ".png", ".jpg", ".jpeg", ".webp"),
    "backgrounds": (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov"),
    "poses":       (".json", ".vroidpose"),
    "audio":       (".wav", ".mp3", ".ogg", ".m4a", ".flac"),
    "motions":     (".vrma", ".bvh", ".fbx"),
}

for _k in ASSET_KINDS:
    (ASSETS_DIR / _k).mkdir(parents=True, exist_ok=True)
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

try:
    import folder_paths  # type: ignore
    _INPUT_DIR = Path(folder_paths.get_input_directory())
except Exception:  # ComfyUI 外(開発用サーバー)
    _INPUT_DIR = DATA_DIR / "input"

# 書き出し(レンダー)は ComfyUI の input/ 配下に置き、ノードや標準の LoadImage からも使えるようにする
RENDERS_DIR = _INPUT_DIR / "vrm_pose_studio"
RENDERS_DIR.mkdir(parents=True, exist_ok=True)

try:
    import folder_paths  # type: ignore
    _OUTPUT_DIR = Path(folder_paths.get_output_directory())
except Exception:
    _OUTPUT_DIR = DATA_DIR / "output"
# 3D Pose Editor の出力フォルダ。音声作成の API 設定(api_settings.json)と、そこで作った音声(Audio/)を共有する
POSE_EDITOR_OUT = _OUTPUT_DIR / "vrm_pose_editor"
# 書き出しの「Save to ComfyUI output」の保存先(output/vrm_pose_studio/)
STUDIO_OUT = _OUTPUT_DIR / "vrm_pose_studio"

# 3D Pose Editor(comfyui-vrm-pose-editor)が同じ custom_nodes にあれば、その model/ と poses/ も読む
def _find_pose_editor():
    """3D Pose Editor のフォルダ。開発フォルダを custom_nodes へジャンクションで置いていると、
    ROOT_DIR(resolve 済み)の親は開発フォルダ側になって見つからないので、ComfyUI の custom_nodes 設定と
    解決前のパスも順に探す。環境変数 VPS_POSE_EDITOR_DIR があればそれを使う(dev_server.py 用)"""
    env = os.environ.get("VPS_POSE_EDITOR_DIR")
    if env and Path(env).is_dir():
        return Path(env)
    cands = []
    try:
        import folder_paths  # type: ignore
        cands += [Path(d) for d in folder_paths.get_folder_paths("custom_nodes")]
    except Exception:
        pass
    cands += [Path(__file__).absolute().parent.parent.parent, ROOT_DIR.parent]
    for c in cands:
        if (c / "comfyui-vrm-pose-editor").is_dir():
            return c / "comfyui-vrm-pose-editor"
    return ROOT_DIR.parent / "comfyui-vrm-pose-editor"


POSE_EDITOR_DIR = _find_pose_editor()
EXTRA_SOURCES = {
    "models": [("pose-editor", POSE_EDITOR_DIR / "model")],
    "poses":  [("pose-editor", POSE_EDITOR_DIR / "poses")],
    "motions": [("pose-editor", POSE_EDITOR_DIR / "poses")],
    "audio": [("pose-editor", POSE_EDITOR_OUT / "Audio")],
}


def asset_sources(kind):
    """[(source名, ディレクトリ)] 。先頭が自前の assets/<kind>(アップロード先)。"""
    out = [("local", ASSETS_DIR / kind)]
    for name, d in EXTRA_SOURCES.get(kind, []):
        if d.is_dir():
            out.append((name, d))
    return out
