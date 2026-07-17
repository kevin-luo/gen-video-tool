# 橘猫夜市炒粉

这是提交 `eb11e53` 后的真实本地生产验证项目：7 个连续生成镜头，交付时长 707 帧 / 30 fps（约 23.57 秒）。

- Imagegen 只负责 480×832 起始关键帧；
- WanGP 为每个镜头生成两个 81 帧候选；
- 人工审片后选择候选；
- F5-TTS 使用包内参考 WAV 本地合成；
- Remotion/FFmpeg 生成 1080×1920 H.264/AAC MP4；
- 字幕只输出外挂 UTF-8 SRT，不烧录，不添加 BGM。

源包不包含 `generated/`。请导入桌面工具后执行本地生成。

本次实操的验收交付物：

- [最终 MP4](../../docs/media/cat-noodle-stall-v3.mp4)
- [外挂 SRT](../../docs/media/cat-noodle-stall-v3.srt)
- [72 点 QA 联系表](../../docs/media/cat-noodle-stall-v3-contact-sheet.jpg)

最终 MP4 为 23.5667 秒、1080×1920、30 fps、707 帧，SHA-256 为 `2fcbbb0ec9d1eb9eb9ada4520ab13af1547862137b3ea58d0deff4f27d3db707`。
