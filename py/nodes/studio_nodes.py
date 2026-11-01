"""VRM Pose Studio の ComfyUI ノード。

- VPS_LoadRender : SPA で書き出したレンダー(静止画 / 連番)を IMAGE・MASK バッチとして読み込む
- VPS_SendToStudio: ワークフローの画像を SPA の背景 / プロップ素材として保存する
"""

import json
import time

import numpy as np
import torch
from PIL import Image

from ..config import ASSETS_DIR, RENDERS_DIR
from ..routes import safe_name, unique_path

NONE_RENDER = "(none)"


def _render_names():
    # 動画のみの書き出し(連番 PNG なし)は読み込めないので出さない
    names = [d.name for d in sorted(RENDERS_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True)
             if d.is_dir() and (d / "meta.json").exists() and (d / "frame_00000.png").exists()]
    return names or [NONE_RENDER]


def _load_meta(d):
    try:
        return json.loads((d / "meta.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


class VPS_LoadRender:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "render": (_render_names(),),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 99999}),
                "frame_count": ("INT", {"default": 0, "min": 0, "max": 99999, "tooltip": "0 = all frames"}),
                "every_nth": ("INT", {"default": 1, "min": 1, "max": 100}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT", "INT")
    RETURN_NAMES = ("images", "masks", "fps", "frame_count")
    FUNCTION = "load"
    CATEGORY = "VRM Pose Studio"

    def load(self, render, start_frame=0, frame_count=0, every_nth=1):
        d = RENDERS_DIR / safe_name(render)
        frames = sorted(d.glob("frame_*.png")) if d.is_dir() else []
        if not frames:
            raise ValueError(f"[VRM Pose Studio] render '{render}' has no frames. Export it from the studio (/vps) first.")
        frames = frames[start_frame::every_nth]
        if frame_count > 0:
            frames = frames[:frame_count]
        if not frames:
            raise ValueError("[VRM Pose Studio] start_frame is out of range")

        images, masks = [], []
        size = None
        for f in frames:
            img = Image.open(f).convert("RGB")
            size = size or img.size
            if img.size != size:
                img = img.resize(size, Image.LANCZOS)
            images.append(np.asarray(img, dtype=np.float32) / 255.0)
            mpath = f.with_name(f.name.replace("frame_", "mask_"))
            if mpath.exists():
                m = Image.open(mpath)
                alpha = m.getchannel("A") if "A" in m.getbands() else m.convert("L")
                if alpha.size != size:
                    alpha = alpha.resize(size, Image.LANCZOS)
                masks.append(np.asarray(alpha, dtype=np.float32) / 255.0)
            else:
                masks.append(np.zeros((size[1], size[0]), dtype=np.float32))

        meta = _load_meta(d)
        fps = float(meta.get("fps", 24)) / every_nth
        return (torch.from_numpy(np.stack(images)), torch.from_numpy(np.stack(masks)), fps, len(images))

    @classmethod
    def IS_CHANGED(cls, render, **kwargs):
        d = RENDERS_DIR / safe_name(render)
        meta = d / "meta.json"
        return f"{render}|{meta.stat().st_mtime if meta.exists() else 0}|{kwargs}"

    @classmethod
    def VALIDATE_INPUTS(cls, render=None, **kwargs):
        if render is None:
            return True
        if render == NONE_RENDER or not (RENDERS_DIR / safe_name(render)).is_dir():
            return f"Render '{render}' not found. Export from VRM Pose Studio first."
        return True


class VPS_SendToStudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "target": (["backgrounds", "props"],),
                "filename_prefix": ("STRING", {"default": "comfy"}),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "used as alpha (props only)"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "VRM Pose Studio"

    def send(self, images, target="backgrounds", filename_prefix="comfy", mask=None):
        out_dir = ASSETS_DIR / target
        prefix = safe_name(filename_prefix, "comfy")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        saved = []
        for i, img in enumerate(images):
            arr = (img.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr)
            if target == "props" and mask is not None:
                m = mask[min(i, len(mask) - 1)].cpu().numpy()
                alpha = Image.fromarray((m * 255).clip(0, 255).astype(np.uint8)).resize(pil.size)
                pil = pil.convert("RGBA")
                pil.putalpha(alpha)
            p = unique_path(out_dir, f"{prefix}_{stamp}_{i:03d}.png")
            pil.save(p)
            saved.append(p.name)
        print(f"[VRM Pose Studio] saved {len(saved)} image(s) to assets/{target}")
        return {"ui": {"text": saved}}


NODE_CLASS_MAPPINGS = {
    "VPS_LoadRender": VPS_LoadRender,
    "VPS_SendToStudio": VPS_SendToStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VPS_LoadRender": "Load Studio Render (VPS)",
    "VPS_SendToStudio": "Send Image to Studio (VPS)",
}
