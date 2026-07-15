# Gen Video Tool

本地优先的纸片动画视频生产工具。它把 ChatGPT/Imagegen 交付的结构化素材包变成可检查、可编辑、可重复渲染的 MP4，不把日常生产绑定在 Codex、Fal 或付费 I2V 上。

![编辑器概念图](docs/design/editor-concept.png)

## 已实现

- Electron + React 桌面工作台：首页、安全导入检查、三栏编辑器、故事节拍时间线和真实导出进度。
- ZIP/目录导入门禁：路径穿越、绝对路径、大小写/Unicode 冲突、符号链接、ZIP bomb、重复 ID、丢失引用、图像/Alpha、音频和 SRT 检查。
- 三种人物协议：Rigid Actor、Mesh Puppet 协议边界、Pose Cut 完整人物姿态切换。
- 8 个确定性 Motion Recipes；背景、主体、道具、前景按深度独立视差，标题保持低/零视差。
- 编辑器预览与最终渲染共用 Remotion 运动求值器。
- 本地 Remotion + FFmpeg：H.264 MP4、旁白混合、独立 SRT、起/中/末抽帧 QA；默认无 BGM、无烧录字幕。
- Godot worker 协议、可执行文件探测和诚实的示例 worker；未伪装“自动蒙皮已可商用”。
- 足球与安静故事两套可验证、可渲染示例。
- 可安装技能：[`compose-paper-video`](skills/compose-paper-video/SKILL.md)。

## 快速开始

要求 Node.js 22+、npm、Chrome 或 Edge。首次安装 Electron/Remotion 组件需要联网。

```bash
npm install
npm run typecheck
npm run test
npm run validate:examples
npm run dev
```

只调试 React 渲染层：

```bash
npm run dev:renderer
```

## 验收渲染

```bash
npm run render:football
npm run render:story
npm run qa:frames
```

产物：

```text
output/football/final.mp4
output/football/subtitles.srt
output/football/qa-frames/*
output/story/final.mp4
output/story/subtitles.srt
output/story/qa-frames/*
```

`subtitles.srt` 是外挂文件，不会烧录进视频；`final.mp4` 只混合旁白，不添加背景音乐。

## 素材包

```text
asset-pack/
├── manifest.json
├── narration.txt
├── subtitles.srt
├── audio/narration.wav
├── assets/backgrounds/
├── assets/characters/
├── assets/props/
└── shots/<shot-id>/shot.json
```

生成资产前必须为每个镜头声明：相机位置、人物朝向、动作轴、目标/接触点、支撑与地面、深度顺序、遮挡物和起止状态。完整生产规范在 [`chatgpt-asset-director`](chatgpt-asset-director/INSTRUCTIONS.md)。

## 人物动画边界

- `Rigid Actor`：完整人物整体位移、缩放、轻微旋转和一次性入场。
- `Pose Cut`：两张或更多完整人物姿态；仅在硬切、纸片/道具全遮挡、闪帧、撕纸或切镜下切换，永不交叉淡化。
- `Mesh Puppet`：连续完整纹理 + 隐藏网格骨骼 + 已验证 `rig.json`。当前仓库提供协议与 Godot 示例 worker，不宣称自动 rig 已达到生产质量。

禁止拆肢、幻肢式关节、人物 flip/fold、默认循环 bob、整张海报同平面运镜。

## 架构

```text
apps/desktop              Electron 主进程、受限 preload、React 编辑器
packages/schema           schema v2 与迁移
packages/asset-pack       安全导入、媒体检查、项目读写
packages/motion-core      8 个动作配方、事件编译、独立图层视差
packages/remotion-engine  共享预览/导出的画面求值器
packages/render-service   Remotion 渲染、旁白混合、外挂 SRT、QA
packages/worker-client    Godot/RIFE 可选 worker 协议
motion-worker             Godot 示例 worker
chatgpt-asset-director    ChatGPT/Imagegen 素材生产契约
skills                    可安装的 Codex 技能
examples                  足球与故事资产包
```

更详细的信任边界和数据流见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 安全与本地性

- Renderer 无 Node 权限，只能通过窄 IPC 调用。
- 文件选择后使用一次性句柄；Renderer 不能提交任意路径给导入器。
- 导入先进入 staging，通过全部阻断项后原子提交。
- 本地素材通过 `gen-video-asset://` 受限协议读取，并执行根目录包含检查。
- 删除仅允许应用项目根目录下的非只读项目。

## License

MIT
