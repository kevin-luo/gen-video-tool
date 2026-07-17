# Development plan

## 2026-07-17 状态基线

项目已经转为 greenfield v3，不再安排旧格式兼容或迁移器。当前目标是完成一条可以被证据证明的本地闭环：便携源资产包 → WanGP 双候选 → 人工选片 → F5-TTS → Remotion/FFmpeg 交付。

已经有一条完整真实运行证据链：

- WanGP 官方 MCP stdio、本机 CUDA/PyTorch 环境和 Fun InP 1.3B 完成两轮双候选生成；
- 人工拒绝错误动作并接受 seed `314159` 的连续拉窗帘候选；
- 本地 F5-TTS 完成真实参考音频克隆、时长补齐和外挂 SRT；
- Remotion/FFmpeg 完成 1080×1920、30 fps、101 帧 H.264/AAC 成片；
- Electron 真实执行动态预览与导出，生成 20 张 QA 抽帧且控制台零错误。

当前 [`examples/morning-light-v3`](../examples/morning-light-v3/README.md) 是干净、便携的源资产包；验收成片和联系表位于 `docs/media/`，完整候选与工作状态只保留在本机应用数据目录。

## 已完成基础

### P0 — v3 产品契约与资产边界

状态：实现并有自动测试。

- `production.json` 是唯一项目入口，`schemaVersion` 固定为 3；
- 不读取旧 manifest 或逐镜头 JSON；
- `generated-performance` 与 `layered-collage` 两种镜头来源；
- 方向、支撑、接触、里程碑、相机所有权和确定性道具均为结构化字段；
- 生成原生尺寸/时间基准与 1080×1920、30 fps 交付契约分离；
- 字幕 `burnIn: false`，`bgm: null`；
- `production.json` 与 `generated/production-state.json` 原子读写及重启中断恢复。

### P1 — v3-only 资产包

状态：实现并有自动测试。

- 目录和 ZIP 导入；
- 唯一根 `production.json`，最多一层包装目录；
- 路径穿越、链接、碰撞、压缩比和容量限制；
- 首/尾关键帧、拼贴图层、确定性道具、局部遮挡和 F5 参考音频检查；
- 关键帧按 WanGP 原生 raster 验证；
- 源资产包禁止包含 `generated/`；
- 全部门禁通过后才原子提交，不覆盖已有项目。

### P2 — 本地 WanGP 生成层

状态：接口、状态机、真实 1.3B 运行和新 v3 样片均已验证。

- 官方 MCP stdio 与 Streamable HTTP 传输；
- 模型列表、availability、metadata、defaults 和 schema 动态发现；
- WanGP Python 环境的真实 CUDA kernel 探测；
- start-only / start-end conditioning，能力不匹配时提交前失败；
- 两枚不可变 seed 串行生成，不自动选片；
- ASCII-safe staging、真实输出复制、媒体探测和稳定错误码；
- 持久生产状态、进度、取消和重启中断记录；
- 本地视频文件导入时保留 H.264/yuv420p/CFR/静音规范化能力；导入文件仍必须通过技术 QA，不作为本地模型生成证据。

### P3 — 本地 F5-TTS

状态：真实 WAV 已验证；v3 生产门禁和脚本已实现。

- 参考音频与参考文本克隆；
- 多段旁白串行生成与 PCM WAV 探测；
- 原子合并、超时长拒绝、尾部静音补齐；
- 旁白状态、哈希和逐段时间持久化；
- 从实际语音时长生成独立 SRT；
- 未完成候选选择时禁止生成旁白。

### P4 — Electron 工作流

状态：核心界面、窄 IPC 与新样片端到端验收已完成。

- 只接受 v3 源资产包的首页与导入门禁；
- “资产 → 生成 → 审片 → 交付”四阶段可视流程；
- 首次进入生产区自动探测 Provider，支持显式重新探测；
- 两候选、技术 QA、人工选择和拒绝原因；
- 所有禁用操作显示附近原因；
- 视频选择完成后才解锁旁白，旁白完成后才解锁导出；
- Renderer 不获得任意文件系统或 shell 权限。

## 已完成关键路径 — v3 样片验收

状态：完成。

1. 对 `morning-light-v3/shot-01` 完成本地 Provider 探测；
2. 用 `production.json` 中两枚固定 seed 串行生成两个真实候选；
3. 对每个候选执行文件、编码、尺寸、帧率、帧数和音轨技术 QA；
4. 人工检查身份、五官、手脚、支撑、动作方向、节奏和镜头稳定性；
5. 明确选择一个通过候选，或记录拒绝原因后重新生成；
6. 只有选片完成后，运行 F5-TTS 并检查语速、断句、音色和时长；
7. 由 Remotion 合成确定性图层和单一运镜；
8. 由 FFmpeg 输出 1080×1920、30 fps、H.264/AAC MP4；
9. 输出独立 SRT，不烧录字幕，不加入 BGM；
10. 抽取全片均匀帧和关键里程碑邻帧，完成最终人工验收。

完成证据包括：两候选文件与探测数据、QA/选择状态、最终 WAV、SRT、MP4、抽帧图、桌面真实导出及可复现的 seed/preset 记录。仅有启动日志、进度截图或静态首帧仍不算完成。

## 下一阶段

### P5 — 端到端可靠性收口

状态：进行中；跨进程锁、恢复、媒体 Range、真实桌面启动冒烟、可信 IPC/导航边界、流式 ZIP 解压上限、WanGP 取消截止时间、候选/Matte 哈希复验和最终媒体规格门禁已完成。

- 清除所有跨包 v3 类型不一致，仓库级 `typecheck` 全绿；
- 覆盖桌面导入、生成、取消、重启、选择、旁白和导出的集成测试；
- 为模型缺失、磁盘不足、断连、损坏候选、旁白超时长和导出失败增加可行动恢复路径；
- 保证所有长任务可观测且不会重复提交；
- 生成报告保存模型、preset、seed、请求、哈希和 QA 决策。

### P6 — 自然度与镜头质量

状态：规划。

- 按动作类型建立完整首/尾姿态与镜头模板，而不是拆肢模板；
- 增强身份、解剖、脚底支撑、方向和时间一致性抽帧检查；
- 完善局部 matte/foreground 遮挡修正；
- 扩充确定性接触道具和轨迹求值器；
- 把动作节拍、景别、焦点和运镜幅度变成可复用镜头配方；
- RIFE 只能在原始动作通过后用于交付补帧，不能修复错误动作或错误物理。

### P7 — 可复用产品化

状态：后续规划。

- Windows 安装包和本地依赖诊断；
- 可替换 Provider 配置，不把某个模型字段泄漏到项目契约；
- 批量项目队列与多平台安全区/画幅适配；
- ChatGPT 资产包 Skill 的版本化发布和示例模板；
- 模板市场、团队共享和商业 API 只在许可、审计与核心闭环稳定后推进。

## 明确不做

- 不增加 v2 读取、迁移或“自动兼容旧项目”；
- 不用静态 PNG 平移、姿势切换或拆肢木偶冒充连续人物动画；
- 不让随机 I2V 同时拥有确定性球/道具的因果轨迹；
- 不用 RIFE、快速剪辑、字幕、音效或 BGM 掩盖动作错误；
- 不在未完成人工选片时自动生成旁白或导出；
- 不把“模型任务返回成功”直接等同于内容通过或成片完成。

## 验收命令

```bash
npm run validate:production -- examples/morning-light-v3
npm run local:production:detect -- <本地工作项目目录>
npm run local:production:generate -- <本地工作项目目录> open-curtains
npm run local:production:status -- <本地工作项目目录>
npm run local:production:select -- <本地工作项目目录> open-curtains <实际候选ID>
npm run narrate:production -- <本地工作项目目录>
npm run render:production -- <本地工作项目目录> <输出目录>
npm run build:desktop
npm run typecheck
npm run test
npm run test:desktop-startup
```

`select` 中的候选 ID 必须来自本轮实际状态，不能机械照抄示例。仓库演示成片已经通过上述关键路径；后续样片仍必须逐个走完同样门禁。
