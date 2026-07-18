# RTX 3060 Ti 本地视频模型选型（可选 Wan 写实模式）

## 结论

这份基准只回答“用户显式选择 Wan 写实连续视频时，RTX 3060 Ti 用什么档位”的问题。当前产品默认仍是 **paper-collage**：完整 PNG 纸片分层、确定性 Remotion 动画、F5-TTS 和外挂 SRT；FastWan 2.2 TI2V 5B（3 步，INT8/BF16 混合权重）是可选的写实模式推荐。

它不是参数最小的模型，却在同首帧实测中同时取得了更快的有效去噪、更强的主体动作、更高的画面锐度和更低的显存峰值。因而在 Wan 面板中标为“推荐 · 速度画质平衡”；这不会改变 paper-collage 的产品默认值。Fun InP 1.3B 保留为低内存回退，Wan2.2 14B Lightning/LightX 4-step 只作为高内存机器的质量档，FP8/NVFP4 模型不会进入 RTX 30 自动推荐。

## 实测条件

- GPU：NVIDIA GeForce RTX 3060 Ti，8 GiB，Compute Capability 8.6；
- 驱动：580.88；
- PyTorch：2.10.0+cu130，CUDA 13.0；
- 系统内存：32 GiB；
- 输入：`examples/cat-noodle-stall-v3` 的同一张 480×832 小猫摊位首帧；
- 输出：480×832、24 fps、49 帧（2.0417 秒）；
- 文案、负面提示词和 motion strength 完全相同；
- 固定 Seed：940001；
- 每次只生成一个候选；
- 时间包含桌面后端、WanGP 冷启动、模型加载、文本编码、去噪、VAE 和规范化编码。

## 结果

| 指标 | Fun InP 1.3B | FastWan 2.2 5B | 判断 |
|---|---:|---:|---|
| 有效步数 | 20 | 3 | FastWan |
| 端到端时间 | 241.426 s | 191.881 s | FastWan 快 20.5% |
| 扩散去噪 | 87.494 s | 9.561 s | FastWan 快 9.15× |
| 峰值显存 | 4527 MiB | 4250 MiB | FastWan 低 277 MiB |
| 峰值系统内存 | 29283 MiB | 31058 MiB | Fun 低 1775 MiB |
| 相邻帧变化均值 | 1.4351 | 2.5853 | FastWan 主体动作更充分 |
| 平均光流 | 0.1446 px | 0.2046 px | FastWan 高 41.5% |
| 时序 jerk | 0.1437 px | 0.1164 px | FastWan 低 19.0% |
| 冻结帧转场 | 0 / 48 | 0 / 48 | 都无冻结 |
| 清晰度均值 | 907.0 | 1692.8 | FastWan 高 86.6% |

FastWan 连续运行两次得到的 MP4 SHA-256 完全一致：

```text
CDED7D11DC4A505749FC5124D2325DC95444E217F8300A3FD05DA77222204A41
```

这证明固定模型、首帧、提示词、Seed 和运行参数时，当前链路可以复现。第二次运行比第一次的 204.230 秒进一步降到 191.881 秒；差异来自启动与缓存阶段，视频内容本身未改变。

## 画面判断

Fun InP 更接近输入人物造型，但主要表现为举爪和锅盖位移，动作幅度偏小。FastWan 会出现更明显的躯干前倾、视线变化、手臂和锅盖协同，炒制行为更像一个连续动作；画面也更锐利。三联抽帧由桌面基准工具在 0.25、1.00、1.75 秒自动生成，不能再用单张中间帧代替动画验收。

FastWan 的代价是身份约束更敏感：本次输入中的红色头巾没有稳定保留。生产资产包必须把服装、毛色、标志性配件和不可变化项写入人物 identity anchor，并在提示词中明确重复；需要严格落点的动作应增加合法尾帧，而不是依赖一句宽泛动作描述。

## 为什么不把 14B 设为默认

WanGP 动态元数据在本机选择的是 Wan2.2 14B INT8/BF16 主模型配 4-step Lightning/LightX 混合加速；Wan2.1 14B LightX2V 是回退候选。两条路径都还需要 14B 主权重、加速 LoRA、文本编码器和 VAE。当前 32 GB 主机仅运行 5B 已达到约 30.3 GiB 峰值，14B 没有足够的批量生产余量，因此只保留为可选质量档。

Enhanced Lightning v2 需要两份约 14.3 GB 的 FP8 high/low 专家权重。RTX 3060 Ti 的 Compute Capability 8.6 没有原生 FP8 路径；即使运行时可以软件解码，也会引入额外内存和算力开销。它和 NVFP4 一样，不进入 RTX 30 自动档位。

## 最佳生产算法

1. Codex / ChatGPT 对话中的资产 Skill 生成可下载 ZIP 或目录，包含 `production.json`、无人物底板、首尾关键帧、人物 identity anchor、道具状态和世界/物理约束。
2. 用户把资产包下载到本机后导入桌面工具；桌面端不保存云端模型 Token，也不内置云资产生成接口。
3. 基准和快速试片先做 2.04 秒、49 帧；正式动作镜头可用 3.375 秒、81 帧。一个镜头只表达一个因果动作，例如“握住锅盖 → 抬起 → 放到左侧台面 → 手离开”。
4. Wan 写实模式用 FastWan 5B、3 步、一个候选。短蒸馏模型不再叠加 TeaCache/MagCache，也不重复加载同名 FastWan LoRA；paper-collage 默认路径不启动 Wan。
5. 同一批镜头复用一个常驻 WanGP Worker，模型和文本编码器只加载一次；逐镜头冷启动会掩盖 9.15× 的真实去噪优势。
6. 生成后自动检查分辨率、帧数、冻结率、光流、时序 jerk 和三联抽帧。世界逻辑、手脚数量、身份配件、道具接触仍由人审；未通过时只重生成该镜头。
7. 通过的镜头再进入 Remotion 做统一运镜、遮挡、转场和声音合成。AI 视频负责主体与环境的真实连续表演，Remotion 不再伪造人物肢体动画。

## 复现命令

```powershell
npm run benchmark:wangp:desktop -- examples\cat-noodle-stall-v3 snapshot
npm run benchmark:wangp:desktop -- examples\cat-noodle-stall-v3 fun-inp-1.3b
npm run benchmark:wangp:desktop -- examples\cat-noodle-stall-v3 fastwan-5b

$env:WANGP_PYTHON = 'D:\AI\WanGP\env_conda\python.exe' # 改为本机 WanGP Python
& $env:WANGP_PYTHON scripts\video-motion-metrics.py `
  .desktop-data\wangp-benchmark\projects\cat-noodle-stall-v3\generated\benchmarks\fun-inp-1.3b.mp4 `
  .desktop-data\wangp-benchmark\projects\cat-noodle-stall-v3\generated\benchmarks\fastwan-5b.mp4
```

运行产物保存在独立桌面数据目录，不提交生成视频和模型权重。仓库只保存可复现的发现逻辑、基准入口、质量算法和资产包工作流。
