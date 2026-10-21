# QQ Agent 扩展集

[QQ Agent](https://kondius.cn/qq-agent/)（QQ 群 AI 机器人，Electron 桌面版）的自建插件与技能集合。
每个目录都自带清单（`plugin.json` / `skill.json`），把目录复制进安装目录的 `plugins/` 或 `skills/` 即可，重启生效。

| 目录 | 类型 | 一句话 |
|---|---|---|
| `skills/autopilot` | 技能 | 办事模式：任务清单 + 完全权限的手（跑命令、读写文件、截图点鼠标），答应了就得办成 |
| `skills/localchat-kit` | 技能 | **本地聊天安装包**：自带补丁数据，让她自己把聊天页写进宿主代码（备份可还原） |
| `plugins/local-chat` | 插件 | 配合上一个技能：控制台里的「聊天」页签开关 |
| `plugins/reply-safety-plus` | 插件 | 回复安全网：她把话写在正文里却忘了调 `send_message` 时把成品话抢救出去 |
| `plugins/hide-clear-archive` | 插件 | 把存档页那个「清空存档」按钮藏起来（只隐藏不删元素，关插件即恢复） |
| `plugins/chat-archive-sync` | 插件 | 聊天记录发布：说「发布」上传某段存档、说「读取」拉回来覆盖本地；未配置 GitHub 时走本机目录 |

## 为什么有 localchat-kit 这种"改代码"的技能

「本地聊天」那套改动落在核心模块（`src/app.js` / `routes.js` / `sender.js` / `prompt.js` /
`orchestrator.js` / `store.js` + `ui/` 三个文件），插件 API 碰不到，所以没法直接打包。
于是把差异转成数据（`patches.json` 里一条条 `{find, replace}`），由技能在安装时应用：

- 改之前 **整份备份** 到 `<数据目录>/localchat-kit-backup/<时间戳>/`
- 每条补丁要求「在目标文件里唯一命中」，否则整次中止（不猜位置）
- 已装过视为幂等；版本对不上就报错不动手
- `localchat_uninstall` 用备份一键还原

## 安装

1. 找到安装目录（默认 `C:\Users\<你>\AppData\Local\Programs\QQ Agent\resources\app`）。
2. 技能放 `skills/`、插件放 `plugins/`，目录名要和清单里的 `id` 一致。
3. 重启 QQ Agent；在「技能」/「插件」页看到条目即成功。
4. 想用本地聊天：先启用 `local-chat` 插件，再让她跑 `localchat_install`，然后重启。

## autopilot 技能要点

- **办事底线**：没有对应工具时不许直接说"做不了"——先找现成方案，再拆步骤/写脚本，必要时自己造工具。
- **主人 QQ**：设置里填了就只认这个号（优先级高于其它身份判定）。
- **电脑操作**：`screen` 截图 / `mouse` 点击拖拽 / `keyboard` 打字快捷键 / `window` 切窗口。
  脚本以 `tools/computer.ps1.txt` 存放，运行时才落地成 `.ps1`（打包/安装环节会拦 ps1 后缀）。

## chat-archive-sync 要点

- 设置：`token` / `repo` / `branch` / `pathPrefix` / `localDir` / `includeSelf`。
- **不填 token + repo 就默认写本机**：`<数据目录>/archive-sync/`。
- 文件名按 `chatKey` 转义（`private_123.json` / `group_456.json`），私聊与群不会串。
- 「读取」是**覆盖**本地同 key 的存档，不可撤销。

## 许可

MIT。作者：小鱼（本机自建）。
