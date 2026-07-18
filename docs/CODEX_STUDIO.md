# Codex Studio

Codex Studio 把 Gen Video Tool 的 v3 本地生产链路变成一个可安装的 Codex 插件。它采用“对话导演 + 窄 MCP 工具 + localhost 可视制作台”三层结构：Codex 负责文案、镜头和 Imagegen 源资产，本机负责 WanGP、F5-TTS、Remotion 与 FFmpeg，用户在浏览器中审片和控制任务。

## 安装

```bash
codex plugin marketplace add kevin-luo/gen-video-tool --ref main
codex plugin add gen-video-tool@gen-video-tool
```

安装或更新插件后新建 Codex 任务，再说：

```text
启动 Gen Video Tool，并告诉我本地制作台地址。
```

首次启动若没有 `node_modules`，插件会在自己的安装目录运行 `npm install`。完成后会返回类似 `http://127.0.0.1:4390/?session=...` 的私有地址。

## 生产职责

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Codex Skill | 理解需求、文案、镜头、世界/物理约束、Imagegen 资产、选择下一步 | 不伪造模型成功，不自动代替用户审片 |
| MCP | 项目读取、资产包检查/导入、本地任务、候选选择/拒绝 | 不接受任意 shell，不向云端上传素材 |
| localhost 制作台 | 项目状态、实际媒体预览、门禁、任务日志、人工操作 | 不读取 Cookie、订阅 Token 或对话历史 |
| 本地生产包 | WanGP、F5-TTS、Remotion、FFmpeg、媒体 QA | 不用静态首帧冒充连续视频 |

## MCP 工具

插件暴露 14 个窄工具：

- 状态：`gen_video_get_status`、`gen_video_list_projects`、`gen_video_get_project`；
- 资产包：`gen_video_inspect_asset_pack`、`gen_video_import_asset_pack`；
- 长任务：`gen_video_detect_runtime`、`gen_video_generate_shot`、`gen_video_synthesize_narration`、`gen_video_render_project`；
- 任务控制：`gen_video_get_job`、`gen_video_list_jobs`、`gen_video_cancel_job`；
- 人工审片：`gen_video_select_candidate`、`gen_video_reject_candidate`。

检测、生成、旁白和渲染都是异步任务。启动工具立即返回任务 ID；Skill 通过 `gen_video_get_job` 跟踪到 `complete`、`failed`、`cancelled` 或 `interrupted`。同一项目/镜头的等价任务在排队或运行时不会重复创建。

## 从一句话到视频

推荐对话：

```text
做一条 20 秒 9:16 视频：可爱小猫在夜市摆摊卖炒粉。
文案口语化；先写动作轴、支撑面、接触时序和单一运镜。
用 Codex 内置 Imagegen 生成完整首尾关键帧和透明确定性道具，
导入后用本地 WanGP 逐镜头生成候选。每个候选让我审片，
全部通过后用 F5-TTS 生成旁白，再渲染 MP4 + 外挂 SRT。
不要 BGM，不要烧录字幕。
```

实际顺序：

```text
文案/镜头/世界契约
-> $create-gen-video-asset-pack + 内置 Imagegen
-> 资产包检查与原子导入
-> WanGP 运行时检测
-> 单 Seed 候选生成
-> 技术 QA
-> 用户在 localhost 制作台看实际视频并接受/拒绝
-> F5-TTS
-> Remotion + FFmpeg
-> MP4 + 外挂 SRT
```

生成动作不会自动替用户选择候选。拒绝后可再次生成计划中的下一个不可变 Seed；所有连续表演镜头都有通过候选后才解锁旁白，旁白完成后才解锁渲染。

## 安全边界

- Web 服务只监听 `127.0.0.1`，不监听局域网或公网地址；
- 每次插件启动生成高熵临时会话令牌，API 同时检查令牌和浏览器 Origin；
- CSP 禁止内联脚本、外部连接、表单提交、对象和跨站嵌入；
- 媒体读取必须解析到项目根或输出根内，拒绝路径穿越；
- ZIP/目录仍经过 `packages/asset-pack` 的路径、体积、压缩比、媒体与引用校验；
- 所有本地子进程使用 executable + argument array、`shell: false`；
- 运行时检测只返回有界摘要，避免把完整模型目录塞进 MCP 结果与持久任务文件；
- 插件不会导入 Cookie、授权 JSON、订阅 Token，也不会模拟 Codex/ChatGPT 的身份。

## 本地开发与验证

```bash
npm install
npm run codex:studio
npm run test:codex-plugin
npm run typecheck
npm test
```

`test:codex-plugin` 会从根启动真实插件进程，完成 MCP initialize、工具枚举、状态工具调用、healthz 和浏览器 HTML 探测，然后干净退出。

若端口 `4390` 被占用，可设置 `GEN_VIDEO_STUDIO_PORT`。项目和任务默认保存到源码工作区的 `.desktop-data/`；安装版保存到用户目录的 `.gen-video-tool/`。设置 `GEN_VIDEO_STUDIO_HOME` 可覆盖数据根。

## 故障定位

- 制作台打不开：检查 Codex 任务中的插件启动日志和端口占用；不要手工复用旧 session URL；
- 页面显示未连接：从当前 Codex 任务重新获取 `studioUrl`，会话令牌随插件进程变化；
- 检测失败：先运行 `npm run local:production:detect -- <项目目录>`，检查 WanGP Python、CUDA 和模型 availability；
- 生成失败：读取对应任务的最后日志和候选技术 QA，不要回退到静态图片；
- 重启后任务中断：这是显式恢复语义，确认本机模型状态后重新发起该步骤。
