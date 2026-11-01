"""VRM Pose Studio — 3D Pose Editor をベースにした SPA(/vps)と、その書き出しを使う ComfyUI ノード。"""

import importlib

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web/comfyui"

try:
    from server import PromptServer  # type: ignore
    from .py.routes import setup_routes

    setup_routes(PromptServer.instance.app)
except Exception as _e:
    print(f"[WARNING] VRM Pose Studio: failed to register routes: {_e}")

# 1つの壊れた依存が全ノードを道連れにしないよう個別に読み込む
try:
    _mod = importlib.import_module(".py.nodes.studio_nodes", package=__name__)
    NODE_CLASS_MAPPINGS.update(_mod.NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(_mod.NODE_DISPLAY_NAME_MAPPINGS)
except Exception as _e:
    print(f"[WARNING] VRM Pose Studio: failed to load nodes: {_e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
