# Codex Studio

Codex Studio 把 Gen Video Tool 的本地生产链路变成一个可安装的 Codex 插件。默认视觉合同是 paper-collage：文案拆成 narration-aligned beat 和视觉隐喻，准备完整角色与每镜 3–6 个纸片组，再由 Remotion 确定性组装，F5-TTS 生成旁白，FFmpeg 完成编码与抽帧 QA，最后交付 MP4 与外挂 SRT。Wan 只用于用户显式选择的写实连续视频，或合适的无人物背景底板。

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
| Codex Skill | 文案分 beat/隐喻、调用内置 Imagegen 生成完整角色与纸片组、导入资产包、跟踪本地任务 | 不伪造模型成功或媒体路径 |
| MCP | 创作创建/重试、项目读取、资产包导入、本地任务、候选审片 | 不接受任意 shell，不向云端上传素材 |
| localhost 制作台 | 保存创作请求、显示真实任务/媒体状态、接受已配置 Provider 或用户资产包 | 不调用 Codex Imagegen，不读取 Cookie、订阅 Token 或对话历史 |
| 本地生产包 | 纸片组装、F5-TTS、Remotion、FFmpeg、媒体 QA；可选 WanGP | 不用占位图或静态首帧冒充成片 |

## MCP 工具

插件暴露 20 个窄工具：

- 一键创作：`gen_video_create_from_script`、`gen_video_list_creations`、`gen_video_get_creation`、`gen_video_retry_creation`；
- 纸片资产：`gen_video_inspect_collage_assets`、`gen_video_attach_collage_assets`；
- 状态：`gen_video_get_status`、`gen_video_list_projects`、`gen_video_get_project`；
- 资产包：`gen_video_inspect_asset_pack`、`gen_video_import_asset_pack`；
- 长任务：`gen_video_detect_runtime`、`gen_video_generate_shot`、`gen_video_synthesize_narration`、`gen_video_render_project`；
- 任务控制：`gen_video_get_job`、`gen_video_list_jobs`、`gen_video_cancel_job`；
- 人工审片：`gen_video_select_candidate`、`gen_video_reject_candidate`。

`gen_video_create_from_script` 只创建 `awaiting-assets` 请求，不会启动 Wan 或伪造视频。`gen_video_inspect_collage_assets` 只读校验本地 v3 pack；`gen_video_attach_collage_assets` 原子附加通过校验且时长匹配的 `layered-collage` pack，并排队 F5-TTS 与 Remotion/FFmpeg。Skill 随后通过 `gen_video_get_creation`，必要时通过 `gen_video_get_job`，跟踪到 `complete`、`failed`、`cancelled` 或 `interrupted`。

## 从一句话到视频

最快的推荐对话：

```text
把下面文案做成 20 秒抖音竖屏纸片拼贴视频：
“夜市快收摊时，一只小猫还在认真翻炒最后一份炒粉……”
小猫必须是一张完整角色纸片；每镜 3–6 个大组从空场错峰组装。
不要 BGM，不要烧录字幕。
```

实际顺序：

```text
成稿文案 + 平台 + 时长
-> gen_video_create_from_script（状态：awaiting-assets）
-> narration-aligned beat + 一句话视觉隐喻
-> Imagegen 完整角色 + 每镜 3–6 个透明纸片组
-> v3 layered-collage 资产包
-> gen_video_inspect_collage_assets
-> gen_video_attach_collage_assets
-> Remotion slide / snap / stamp / settle + 明确 z-order/遮挡
-> F5-TTS 旁白
-> Remotion 渲染 + FFmpeg 抽帧/编码 QA
-> MP4 + 外挂 SRT
```

工具调用顺序固定为：`create_from_script → Imagegen/图片 Provider 资产包 → inspect_collage_assets → attach_collage_assets → get_creation poll`。attach 之前 creation 不进入旁白或渲染阶段。

角色或动物必须保持一张完整透明 PNG，只允许平移、旋转和缩放；不得拆手脚、网格形变或在 settle 后恢复漂浮。环境、主体、道具和前景按显式 z-order 合成，前景遮挡环境层而不是切开角色。

## Imagegen 与独立运行边界

localhost 页面与 MCP 服务无法直接调用 Codex 内置 Imagegen。它们也不能借用 ChatGPT Cookie、订阅 Token、浏览器登录态或授权 JSON。

- 在 Codex 对话中：先创建 creation，再由 Codex 调用内置 Imagegen，检查素材后保存为本地 v3 `layered-collage` pack，通过 collage inspect 后 attach 到该 creation。
- 独立 localhost/Electron 模式：必须配置图片 Provider，或让用户导入已生成的资产包。
- 两者都没有时：任务应停在图片资产阶段并返回明确下一步，不能回退到 Wan 视频、占位图或伪进度。

WanGP 是可选写实路径。只有用户明确要求自然关节表演、连续写实镜头或无人物背景生成时才运行检测和候选工作流；它不拥有默认纸片角色的运动。

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
- 图片资产阶段阻塞：在 Codex 对话中生成并导入资产包，或为独立模式配置图片 Provider；
- 可选 Wan 检测失败：先运行 `npm run local:production:detect -- <项目目录>`，检查 WanGP Python、CUDA 和模型 availability；
- 生成失败：读取对应任务的最后日志和媒体 QA，不要回退到占位图或静态首帧；
- 重启后任务中断：这是显式恢复语义，确认本机模型状态后重新发起该步骤。
