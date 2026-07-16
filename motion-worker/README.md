# Motion Worker

这里是可运行的本地 Godot Mesh Puppet Worker，不是 unsupported 占位实现。

输入：

- 一张完整、连续、带 Alpha 的人物 PNG；
- 已通过 schema 校验的 `rig.json`；
- 动作模板、幅度、起始帧、有效帧数、fps 与输出规格。

Worker 会创建 `Skeleton2D`、分层 `Bone2D` 和带骨骼权重的连续 `Polygon2D` Mesh，逐帧求值动作模板，并输出：

- `png-sequence`：`frame_000000.png` 起的透明序列；
- `transparent-webm`：VP9 + Alpha；
- `alpha-mov`：ProRes 4444 + Alpha。

Godot 的 `--headless` 会关闭 RenderingServer，因此透明逐帧渲染不能使用 headless 模式。客户端在 Windows 上使用隐藏窗口与离屏位置运行：

```text
godot --display-driver windows --audio-driver Dummy --rendering-method gl_compatibility \
  --windowed --position -10000,-10000 --path motion-worker/godot -- \
  --request request.json --result result.json
```

动作模板位于 `godot/actions/action-templates.json`。Electron 与批量渲染都调用同一 Worker；渲染失败会返回结构化错误，不会自动回退成静态人物。自动绑定是可编辑的启发式首稿，仍需在桌面校正台检查关节、轮廓和动作幅度。
