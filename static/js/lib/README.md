3D Pose Editor (comfyui-vrm-pose-editor) からそのままコピーしたモジュール。
変更せずに使い、更新するときは元のリポジトリから上書きコピーする。

- bvh_retarget.js / mhr_bind_data.js … BVH(SAM3DBody / CMU / Daz)→ VRM ヒューマノイドのリターゲット
- bvh_import_dialog.js / i18n.js      … BVH 取り込み設定ダイアログ(i18n.js は base の makeT)
- lip_sync.js                         … テキスト→口形タイムライン・音声の音量解析
- image_pose.js / image_pose_solver.js / comfy_api.js … 画像・動画 → SAM 3D Body(ComfyUI ネイティブノード)→ VRM ポーズ。
  使うのは runSam3d / runSam3dVideo / checkSam3dAvailable とソルバーだけ(buildImagePosePanel は使わない)
- vendor/three.module.js                 … 上のソルバーの import を static/vendor へ中継するだけのファイル(コピーではない)
- comfyui-workflow.js                    … Workflow Studio(ComfyUI-Workflow-Studio/static/js)から無変更コピー。
  UI 形式ワークフロー → API 形式の変換(サブグラフ・Bypass・Reroute 対応)に comfyWorkflow.detectFormat / convertUiToApi / applyRandomSeeds を使う
