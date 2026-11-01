"""ComfyUI 無しで SPA を確認するための開発用サーバー。

    python dev_server.py [port]   →  http://127.0.0.1:<port>/vps

レンダーは data/input/vrm_pose_studio/ に保存される(ComfyUI 上では ComfyUI の input/ 配下)。
"""

import sys
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from importlib import import_module  # noqa: E402

routes = import_module(f"{Path(__file__).resolve().parent.name}.py.routes")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    app = web.Application(client_max_size=1024 ** 3)
    routes.setup_routes(app)
    app.router.add_get("/", lambda r: web.HTTPFound("/vps"))
    web.run_app(app, host="127.0.0.1", port=port)
