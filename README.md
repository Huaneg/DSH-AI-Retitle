# DSH AI Retitle

> Rename a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversation from its current content — a sidebar button, a `/retitle` command, and a `retitle_conversation` tool.

会话标题默认由**第一条消息**生成，聊久了往往和实际内容脱节。这个插件让你随时按**整段对话**重新分析、重新命名。

## 三种用法

| 入口 | 位置 | 说明 |
|---|---|---|
| ✨ 悬停按钮 | 侧边栏对话行右侧（`archive` 与 `pin` 之间） | 点一下即重新分析；图标转圈 → 对勾 / 红叉，报错原因在 tooltip 里 |
| `/retitle` 命令 | 输入框 | 可带侧重：`/retitle 重点是新插件的安装` |
| `retitle_conversation` 工具 | agent 侧 | 带可选 `focus` 参数，让模型在话题跑偏后自行改名 |

三条路共用同一个实现（`retitleSession()`），最终只追加一条 `session/title` 事件，因此标题可持久化、可重放，侧边栏即时刷新。

## 安装

```powershell
git clone https://github.com/Huaneg/DSH-AI-Retitle.git
```

然后在 DSH 里二选一：

- 设置 → 插件 → 从本地目录安装，指向 clone 下来的目录；
- 或者让 agent 调 `plugin_manager install_bundle`，`target` 传该目录的绝对路径。

**不需要** `npm install`、不需要 pnpm 依赖、不需要构建步骤：插件目录本身就是可安装的包（Host 是纯 ESM，Client 是宿主模块表里的手写工厂）。

## 兼容性

在 **DSH `0.2.1-rc.2`（Desktop / Windows）** 上验证通过。

它不依赖任何 `@deepseek-ai/*` 包，但依赖以下**当前版本的行为契约**；升级 DSH 后若异常，先查这四处：

| 契约 | 用在哪 |
|---|---|
| `ctx.sessionTitle.get() / rename()` | Host：读取与写入标题 |
| `ctx.llm.stream()`、`ctx.llm.resolveModelInfo()` | Host：生成标题 |
| 客户端 `ctx.remote.commands.execute(agentId, line, attachments, signal)` | 按钮 → `/retitle` |
| slot `sidebar.workspaces.session.row.action` + inject 键 `remote.commands` | 按钮挂载位置 |

## 行为说明

1. 读会话日志，取**最早 2 条**用户消息（撑住原始主题）+ **最近 `maxRecentMessages` 条**用户消息 + **最近 3 条**助手回复；
2. 按 `maxInputBytes` 裁剪：超预算时从中间丢弃，始终保留开头与最新内容；
3. 用**该会话上次请求的模型路由**发一次辅助请求（`purpose: session-title`），并取该模型**最低档**的推理强度；
4. 取首行、去掉包裹的 `**…**` 与引号、清理控制字符，交给 `ctx.sessionTitle.rename()` 归一化并写入。

几个容易误解的点：

- **标题"没变"不等于失败**：模型认为原标题已经准确时，会原样返回，此时按钮显示"标题已更新"但文字不变。
- **写入来源是 `user`**，即显式标题会被"钉住"：之后再发消息不会自动覆盖。想恢复自动标题，再点一次即可。
- **冷会话**（未在当前进程打开）会先被 resume；归档会话可能因此失败并在 tooltip 里报错。

## 配置

可选。写进 profile 的 `cordis.patch.yml`（例如 `~/.dsh/profiles/<name>/cordis.patch.yml`），这是最后一层补丁：

```yaml
- id: ai-retitle
  name: 'dsh-ai-retitle'
  config:
    provider: deepseek          # 与 model 成对出现；省略则跟随会话上次请求的模型
    model: deepseek-chat
    timeoutMs: 30000
    maxOutputTokens: 512        # 推理 token 也计入，别压太小
    maxRecentMessages: 16
    maxInputBytes: 12000
    targetWords: 8              # 非 CJK 目标词数
    targetCjkCharacters: 18     # CJK 目标字数
```

按 id 覆盖会**整体替换**该行的 `config`，所以要么把想要的字段都写上，要么整段省略（全部走默认值）。

`maxOutputTokens` 的坑：推理模型的 reasoning token 也算在这个上限里。设成 96 这类小值，预算会全花在思考上、正文一个字都没输出，表现为 `finish: max-tokens` + 空文本。默认 512 是为了留余量。

## 已知限制

- 全局命名冲突：命令名 `retitle`、slot 槽位 id `ai-retitle`、bundle 行 id `ai-retitle` 都是全局的，同时安装同类插件会互相覆盖。
- 只处理纯文本；图片、工具调用结果不参与命名。
- 标题语言跟随对话语言，不做额外翻译。

## 文件结构

```
index.js           Host 半：命令 + 工具 + 唯一的重命名实现
client.js          Web 半：侧边栏按钮（window.__ModuleLoader__ 工厂）
cordis.patch.yml   bundle 的 loader 行
locale/{en,zh}.json 插件管理页里的标题与描述
icon.svg           插件图标
```

本地开发：改完文件后，在 DSH 里把 bundle 关掉再打开（`plugin_manager set_bundle`）即可重载 Host 侧；客户端改动需要刷新页面。

## License

[MIT](LICENSE)
