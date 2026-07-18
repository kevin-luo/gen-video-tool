# 夜市最后一份炒粉 · 确定性纸片组装样片

这支 20 秒竖屏样片不调用整帧 T2V。Imagegen 只负责生成完整角色和可分离纸片组；抠图后，Remotion 用平移、旋转、等比缩放和显隐逐件组装。角色落位后会完成一次量化的整张纸片 `bob/sway/gesture`，随后精确停稳；没有拆肢、网格变形或无限循环漂移。

- 角色和顾客均为完整轮廓 PNG，不拆手脚。
- 角色层使用可复现的黑白半调纸纹；摊位、彩纸和强调物保留少量点色，避免整张画面变成彩色 AI 贴纸。
- 每镜 5–6 个大组，镜头从空色场开始。
- 角色朝向、气味传播方向、顾客来向和递餐关系均在构图中显式锁定。
- 前景柜台通过 z-order 遮挡小猫下半身，不制造幻肢。
- 成片只有 F5-TTS 旁白；字幕只输出外挂 SRT；不含 BGM。

仓库内验收媒体：

- [最终 MP4](../../docs/media/cat-noodle-collage-v1.mp4)
- [外挂 SRT](../../docs/media/cat-noodle-collage-v1.srt)
- [12 帧 QA 联系表](../../docs/media/cat-noodle-collage-v1-contact-sheet.jpg)

运行：

```powershell
npm.cmd run validate:production -- examples/cat-noodle-collage-v1
npm.cmd run narrate:production -- examples/cat-noodle-collage-v1
npm.cmd run render:production -- examples/cat-noodle-collage-v1
```

如果要把新的完整 PNG 角色统一成参考的半调纸片质感，可逐张运行：

```powershell
npx.cmd tsx scripts/stylize-paper-cutout.ts input-character.png output-character.png 4
```

这个处理只重绘 RGB 印刷点，逐像素保留 alpha、尺寸和轮廓；它不会拆肢、变形或改变动作姿态。
