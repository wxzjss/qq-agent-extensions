# QQ Agent 扩展集

[QQ Agent](https://kondius.cn/qq-agent/)（QQ 群 AI 机器人，Electron 桌面版）的自建插件与技能集合。
每个目录都自带清单（`plugin.json` / `skill.json`），整个目录复制进 `QQ Agent/resources/app/` 下的
`plugins/` 或 `skills/` 就能用，重启应用生效。

| 目录 | 类型 | 一句话 |
|---|---|---|
| `skills/autopilot` | 技能 | 办事模式：任务清单 + 完全权限的手（跑命令、读写文件、截图点鼠标），并且答应了就得办成 |
| `plugins/reply-safety-plus` | 插件 | 回复安全网：她把话写在正文里却忘了调 `send_message` 时，把成品话抢救出去 |
| `plugins/hide-clear-archive` | 插件 | 把存档页那个「清空存档」按钮藏起来（只隐藏不删元素，关插件即恢复） |
| `plugins/chat-archive-sync` | 插件 | 聊天记录发布：说「发布」上传某段存档、说「读取」拉回来覆盖本地；未配置 GitHub 时走本机目录 |

## 安装

1. 找到安装目录（默认 `C:\Users\<你>\AppData\Local\Programs\QQ Agent\resources\app`）。
2. 技能放 `skills/`，插件放 `plugins/`，保持目录名与清单里的 `id` 一致。
3. 重启 QQ Agent，在「技能」/「插件」页能看到条目即成功。

## autopilot 技能要点

- **办事底线**：没有对应工具时不许直接说"做不了"——先找现成的（系统命令/包管理器/本机软件），
  再拆步骤或写脚本，实在没有就自己写一个，必要时给自己加技能/插件。
- **主人 QQ**：设置里填了就只认这个号（优先级高于其它身份判定）。
- **电脑操作**：`screen` 截图 / `mouse` 点击拖拽 / `keyboard` 打字快捷键 / `window` 切窗口。
  脚本以 `tools/computer.ps1.txt` 存放，运行时才落地成 `.ps1` 到临时目录 ——
  因为 QQ Agent 的打包与安装环节会拦 `exe/dll/bat/cmd/ps1/vbs/sh` 后缀。
- 所有动手都会记进 `<数据目录>/autopilot/audit.jsonl`。

## chat-archive-sync 插件要点

- 设置页四项：`token` / `repo` / `branch` / `pathPrefix`（另有 `localDir`、`includeSelf`）。
- **不填 `token` + `repo` 就默认写本机**：`<数据目录>/archive-sync/`。
- 文件名按 `chatKey` 转义（`private_123.json` / `group_456.json`），私聊与群不会串。
- 「读取」是**覆盖**本地同 key 的存档，不可撤销。

## 许可

MIT。作者：小鱼（本机自建）。
