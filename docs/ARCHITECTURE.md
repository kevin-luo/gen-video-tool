# Architecture

## 产品边界

Gen Video Tool 是 greenfield v3 本地视频生产系统。唯一项目契约是根目录的 `production.json`；没有旧格式读取或迁移路径。

架构遵循 [`CONTINUITY_CHARTER.md`](CONTINUITY_CHARTER.md)：

1. 一个镜头是连续世界，不是静态图片切换；
2. 方向、支撑、接触和相机所有权必须在生成前结构化声明；
3. I2V 生成连续表演底片，编辑器拥有物理道具、构图与最终影片；
4. 模型失败、候选未选择、旁白未完成时禁止静默降级；
5. 源资产、模型、候选、旁白、字幕和交付文件默认留在本机。

## 高层数据流

```mermaid
flowchart LR
  A["Codex / ChatGPT Skill\n文案·镜头·Imagegen 源资产"] --> B["下载到本机的 v3 资产包\nproduction.json + assets/"]
  A --> L["Codex MCP\n检查·原子导入·任务编排"]
  B --> C["安全导入\nSchema·路径·媒体·引用检查"]
  L --> C
  C --> D["本地项目\n不可变计划 + generated/ 状态"]
  D --> M["127.0.0.1 制作台\n状态·预览·人工审片"]
  D --> E["WanGP MCP\n能力发现 + 两候选生成"]
  E --> F["技术 QA\n编码·尺寸·帧率·完整性"]
  F --> G["人工审片\n身份·解剖·方向·支撑·接触"]
  G -->|通过并选择| H["F5-TTS\n分段旁白 + 外挂 SRT"]
  G -->|拒绝| E
  H --> I["Remotion\n人物底片 + 确定性道具 + 遮挡 + 单一运镜"]
  I --> J["FFmpeg\nH.264/AAC 编码 + 抽帧验收"]
  J --> K["MP4 + 独立 SRT\n无 BGM·无烧录字幕"]
```

Codex/ChatGPT Skill 只在对话中生产可下载的便携源包，绝不伪造本地生成完成状态，也不要求工具接入云端生成 API。Codex 插件可以通过窄 MCP 工具检查并原子导入用户保存到本机的 ZIP/目录；Electron 用户也可以手动导入。两条入口之后共用同一项目契约、Provider、审片门禁、旁白和渲染服务。

浏览器制作台不是模型代理，也不持有 ChatGPT 凭据。它只绑定 `127.0.0.1`，展示本地项目、候选视频和持久任务，并把用户按钮映射到相同的后端操作。自然语言决策留在 Codex Skill；模型推理、媒体文件与交付结果留在本机。

## 单一 v3 契约

`packages/video-generation/src/production/production-plan.ts` 定义 `ProductionPlan`。核心字段包括：

```text
schemaVersion: 3
projectId / metadata / networkPolicy: offline-only
requiredCapabilities
delivery
narration
shots[]
```

交付契约是精确值，而不是提示性元数据：

```text
1080 × 1920 / square pixels
30 fps / exact durationFrames
H.264 / yuv420p
local PCM WAV -> AAC 48 kHz mux
sidecar SRT / burnIn: false
bgm: null
```

当前只有两种镜头：

- `generated-performance`：人物或动物的连续表演，由本地 WanGP I2V 生成；
- `layered-collage`：背景、标题、图表、产品、透明道具等确定性分层画面。

静态图层不能替代 `generated-performance`。连续人物动作缺少有效视频候选时，项目必须失败。

## 源资产与生成状态

项目数据被故意分为不可变输入与可变工作区：

```text
project-root/
├── production.json                  immutable source contract
├── assets/                          portable source inputs
│   ├── keyframes/
│   ├── props/
│   ├── mattes/
│   └── voice-reference.wav
└── generated/                       desktop-owned mutable outputs
    ├── production-state.json
    ├── provider/
    ├── video/
    ├── review-history/
    ├── audio/
    ├── cache/
    └── final/
```

`production.json` 可以原子重写，但不能被运行时任务偷偷修改。`generated/production-state.json` 保存任务、候选哈希、技术 QA、人工选择和旁白状态。启动恢复只会把此前活动中的任务标记为明确中断，不会伪造完成。

源资产包禁止包含 `generated/`。`packages/asset-pack` 在原子提交前验证：

- 唯一根 `production.json`，最多允许一层下载包装目录；
- ZIP 数量、大小、压缩比、路径穿越、符号链接和名称碰撞；
- 所有首帧/尾帧、拼贴图层、确定性道具、局部 matte 和 F5 参考音频引用；
- 关键帧必须匹配 WanGP 原生生成尺寸，而不是误用交付尺寸；
- 透明道具、人物/前景图层和 matte 必须带 Alpha；
- 任意缺失、损坏或越界引用都会阻止导入。

## 镜头世界契约

每个 `generated-performance` 镜头在调用模型前声明：

```text
subject / supporting actors / target / support surface
normalized action axis: subject -> target
ordered milestones: setup -> anticipation -> plant -> contact/release -> follow-through -> end
facing constraints
support constraints
contact constraints
deterministic prop ownership
one editorial camera operation
```

校验器会阻止零方向轴、倒序里程碑、越界帧、未知角色/支撑面/道具、重复 ID、触发点与接触帧不一致，以及把确定性道具同时留在随机生成画面中的双重所有权。

在含因果道具的镜头中，人物表演底片不拥有道具轨迹。支撑、动作方向和接触里程碑属于世界契约；道具在接触前锁定，接触后由确定性轨迹逐帧求值。这样不会依赖随机模型猜测“道具什么时候才应该动”。

## 运动与画面所有权

| 内容 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 人体姿态、重心、衣物、头发、表情 | WanGP `generated-performance` | 需要连续视频先验 |
| 球、杯子等因果道具及轨迹 | Remotion 确定性交互层 | 接触前后必须逐帧可验证 |
| 接触/释放时刻 | v3 世界契约 | 不由随机生成结果决定 |
| 人物与道具前后遮挡 | matte/foreground layer | 缺少必要遮挡时禁止交付 |
| 推、拉、摇、移 | `editorial-camera` | 默认 I2V 锁镜，合成后只运镜一次 |
| 标题、图表、UI、静态拼贴 | Remotion | 确定性、可编辑、可复现 |
| 旁白与外挂字幕 | F5-TTS + Render Service | 字幕不烧录，BGM 永远为空 |

同一个对象不能有两个运动所有者；同一个镜头也不能同时由生成模型和 Remotion 推近。

## WanGP Provider

`packages/video-generation` 暴露后端中立的 preset、请求、任务、候选和错误类型。WanGP 适配器只通过官方 MCP 工作：

- MCP stdio：桌面端可启动 `wgp.py --mcp --mcp-transport stdio`；
- MCP Streamable HTTP：连接用户已经启动的本机端点；
- Transport 本身只接受 `localhost`、`127.0.0.1` 或 `::1`，并拒绝带凭据或非 HTTP(S) 地址；
- stdio 强制 Hugging Face、Transformers、Datasets 与 W&B 离线模式，缺权重时失败而不是下载；
- 不存在 Gradio 抓取或私有 REST 兼容模式。

Provider 调用模型列表、metadata、availability、defaults 和 schema 来发现真实能力，并单独用 WanGP Python 环境验证 PyTorch CUDA kernel。能看到 `nvidia-smi` 不等于模型环境可运行。

真实本地证据已经覆盖 MCP stdio、Fun InP 1.3B，以及 `morning-light-v3` 的两轮双候选生成。最终接受候选是 480×832、24 fps、81 帧的连续拉窗帘表演；另一候选因把横向拉动变成向上抬帘而被人工拒绝。技术成功与内容通过因此保持为两道独立门禁。

生成条件是判别联合：

```text
start-only: complete startKeyframePath
start-end:  complete startKeyframePath + distinct complete endKeyframePath
```

只有模型 schema 明确支持尾帧时才发送 `SE`；否则提交前失败。每个镜头恰好声明两枚不同 seed，默认串行生成。Provider 复制输入到 ASCII-safe staging、等待真实任务、复制非空视频、再通过媒体探测后才登记候选。

生成分辨率/时间基准与交付契约分离，例如本地模型可以生成 480×832、24 fps、81 帧，再以保持时长的方式适配 1080×1920、30 fps。不能把交付帧号错误当成模型原始帧号。

## 技术 QA 与人工选择

候选经历两道不同门禁：

1. 技术 QA：文件存在、可解码、尺寸、帧率、帧数、编码和音轨符合候选契约；
2. 人工 QA：身份、解剖、动作方向、脚底/手部支撑、接触时序、遮挡、连续性和镜头稳定性。

自动检查不能宣称理解动作的情绪或物理真实性。桌面端只允许选择技术 QA 明确为 `passed` 的候选，人工拒绝原因以结构化记录保留。生成本身永不自动选择。

## F5-TTS 与字幕

`packages/local-tts` 负责发现本机 F5-TTS、以参数数组启动进程、检查 WAV 并返回可审计结果。v3 旁白流程：

1. 所有生成镜头先完成候选选择；
2. 用 `referenceAudioPath` 和 `referenceText` 逐段克隆；
3. 检查每段 PCM WAV，按顺序合并；
4. 旁白不得超过视频时间线，尾部不足使用静音补齐；
5. 写入 `generated/audio/narration.wav` 和逐段时间信息；
6. 由同一时间信息生成独立 SRT。

本机 F5-TTS 的真实 WAV 合成已验证。`morning-light-v3` 旁白有效语音 2.912 秒，按 3.366667 秒时间线补齐尾部静音，并生成独立 SRT；最终桌面预览可完整播放、回零和 seek。

## Remotion 与交付

合成顺序固定为：

```text
selected generated performance plate
-> deterministic prop/background layers
-> local matte or explicit foreground occlusion
-> editorial graphics
-> one editorial camera transform
-> local narration
-> FFmpeg H.264/AAC mux and frame inspection
```

最终视频不烧录字幕、不添加 BGM。字幕作为独立 `.srt` 交付。缺少被选择的候选、必要 matte 或完整旁白状态时，Render Service 必须返回可行动错误，不能回退到静态首帧。

## Desktop 与信任边界

Electron Renderer 不拥有 Node、任意文件系统或 shell 权限。受限 preload 只暴露导入、Provider 探测、生成、状态、选择、旁白和导出所需的窄 IPC。

桌面流程是：

```text
资产导入 -> 本地生成 -> 候选审片 -> 旁白 -> 合成导出
```

生产面板首次进入会自动探测 Provider，也保留显式重新探测。每个禁用按钮附近都有原因；长任务显示当前动作；选择、旁白和导出按状态逐级解锁。macOS/Linux 保持 Renderer sandbox；部分 Windows 主机无法从已有受限令牌再创建 Chromium Renderer 令牌，因此 Windows 仅关闭 Renderer OS sandbox，同时继续强制无 Node integration、context isolation、web security、仅本地/回环 Renderer、主 frame IPC 来源校验、导航拦截和严格 CSP。桌面与自动化使用同一产品启动配置，不靠测试参数绕过错误。

桌面启动、Renderer 退出和加载失败会写入 `userData/logs/desktop.log` 的轮转 JSONL 诊断；日志不记录 IPC 参数、原始环境 URL 或令牌。根目录与 workspace 构建统一写入唯一的 `out/`，桌面快捷方式也只启动该入口，避免旧构建被单实例锁重新聚焦。

所有外部进程使用 executable + argument array 和 `shell: false`；用户中文、空格或 shell 元字符路径仅作为参数数据。写入优先采用同目录临时文件和原子 rename。

## Codex 插件与 localhost 制作台

`.codex-plugin/plugin.json` 把两个生产 Skill 和 `.mcp.json` 打包为一个插件。`scripts/start-codex-plugin.mjs` 在需要时准备依赖，生成高熵临时会话令牌，启动浏览器服务与 stdio MCP，并在 MCP 退出时回收子进程。

`apps/codex-studio` 分为三层：

- `ProjectService`：复用资产包导入器与 v3 状态读取，只允许项目根和输出根内的媒体路径；
- `StudioJobRunner`：串行执行可恢复长任务，持久化任务、日志与结果，阻止等价任务重复排队，重启时把遗留运行态标记为中断；
- HTTP/MCP adapters：浏览器 API 受 Bearer/查询会话令牌与同源校验保护；MCP 只暴露项目、资产包、检测、生成、审片、旁白、渲染和任务控制的窄工具。

浏览器制作台只提供真实可用动作，没有占位按钮。生成候选仍不自动选择：技术 QA 通过后，用户必须在页面看到实际视频并明确接受或给出拒绝原因。长任务在页面关闭后继续执行，重开页面可从持久状态恢复。

## 包边界

```text
apps/desktop                 Electron 主进程、preload、React 编辑器
apps/codex-studio            localhost 制作台、持久任务队列与 MCP server
packages/video-generation    v3 契约、生产状态、Provider、MCP、任务与 QA
packages/asset-pack          v3-only 安全导入、媒体校验、原子提交
packages/frame-interpolation 可选 RIFE 交付补帧；拒绝覆盖已有输出
packages/local-tts           F5-TTS 本地进程、WAV 校验与合并
packages/motion-core         确定性物理与编辑动效求值
packages/remotion-engine     视频、道具、遮挡、图形和单一运镜合成
packages/render-service      旁白/视频交付编排、SRT 与 FFmpeg QA
skills/create-gen-video-asset-pack
                             Web ChatGPT 源资产包工作流
skills/gen-video-studio      Codex 对话式本地生产编排
examples/morning-light-v3    当前 greenfield v3 验收样片
```

v3 产品接口仅由上述包边界和 `production.json` 契约定义。新功能直接演进 v3 契约，不增加旧版本兼容分支。
