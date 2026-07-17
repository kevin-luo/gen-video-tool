# 清晨自然光

这是 greenfield v3 本地生成验收项目。`production.json` 是唯一项目入口；首帧由 Imagegen 生成，连续人物动作由本地 WanGP 生成，两枚固定 seed 需要人工选片，旁白由本地 F5-TTS 合成，最终由 Remotion 输出 1080×1920 H.264 视频和未烧录的外挂 SRT。

源资产包包含 Skill 规定的 `narration.txt`、`narration.segments.json` 与草稿 `subtitles.srt`，不包含 `generated/`。桌面端导入后才会在本地项目副本里创建候选视频、状态、旁白和交付文件。

本项目已经完成一次真实验收：seed `314159` 的候选被选择，F5-TTS 旁白与最终 101 帧成片通过技术及人工 QA。仓库中的便携演示文件位于 [`docs/media/morning-light-v3.mp4`](../../docs/media/morning-light-v3.mp4)，20 帧联系表位于 [`docs/media/morning-light-v3-contact-sheet.jpg`](../../docs/media/morning-light-v3-contact-sheet.jpg)。完整生成状态和原始候选不写回这个源包。

可用同一组生产脚本验证“网页版 Skill 目录 → 确定性 ZIP → 桌面安全导入 → 打开 v3 项目”的完整交接：

```powershell
python skills\create-gen-video-asset-pack\scripts\assemble_asset_pack.py examples\morning-light-v3 .desktop-data\skill-e2e\morning-light-v3.zip
python skills\create-gen-video-asset-pack\scripts\validate_asset_pack.py .desktop-data\skill-e2e\morning-light-v3.zip
npm run verify:asset-pack -- .desktop-data\skill-e2e\morning-light-v3.zip .desktop-data\skill-e2e\projects morning-light-v3-roundtrip
```
