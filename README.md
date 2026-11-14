# hdsh-tavern

独立的 SillyTavern 兼容酒馆插件，与 `hdsh-whale-companion` 完全隔离。

## 边界

- 数据目录：`<DSH_HOME>/tavern`，不读写鲸鱼娘的 `whale-companion` 数据。
- Agent：独立 `tavern-roleplay` 预设；预设 `plugins` 为空，不挂 shell、文件、命令、MCP。
- API：`/tavern/*`，不复用 `/companion/*`。
- 人格：角色卡和世界书只作为上下文，不是可执行指令。

## 0.4.3 已实现

- 角色卡：列表、创建、编辑、删除；JSON（V1/V2/V3）、PNG（tEXt `ccv3`/`chara`）、CHARX/BYAF（ZIP）
- 角色卡内嵌 `character_book` 自动转世界书并随角色删除
- 世界书：列表、创建、条目增删改、导入
- 世界书触发（对齐 SillyTavern）：
  - 字面 key 与正则 key（`/pattern/flags`）
  - `constant`、主/次级关键词、`selectiveLogic`（AND ANY / NOT ALL / NOT ANY / AND ALL）
  - `position` 0/1 角色前/后、2/3 作者注上/下、4 @D 深度、5/6 示例前/后、7 Outlet；`@D` 带 `role`
  - 递归：`excludeRecursion` / `preventRecursion` / `delayUntilRecursion`
  - 分组：逗号分隔多组、`groupWeight` 加权随机、`prioritizeInclusion` 按 order
  - 定时效果：`sticky` / `cooldown` / `delay`，按消息数，不刷新已有计时
  - Min Activations / Max Depth：关键词命中不足时向更早历史继续扫描
  - Character Filter：按角色名/标签过滤，支持排除模式
  - Generation Triggers：`normal` / `continue` / `impersonate` / `swipe` / `regenerate` / `quiet`
  - Outlet：`position = 7` + `outletName`，用 `{{outlet::Name}}` 取用
  - Automation ID：条目激活时执行 `status_schema.automations` 声明的动作（addvar / inject / script）
  - 扫描默认带说话人前缀（`includeNames`），可用角色名触发
  - token/字符预算；同一位置内 `order` 越大越靠后
- 变量：世界书 / 角色扩展声明 `variables`；状态栏 `好感度: +3` 自动累加、clamp、映射阶段；`{{getvar::key}}` 注入；按 chat 持久化
- Prompt：真正的 `messages` 数组（system / user / assistant）；顺序可按 App 配置；缺项自动补齐；历史后指令置尾；支持 `extensions.depth_prompt`（按深度/角色）
- 生成：优先 `ctx.llm.stream(messages[])`；没有 llm 服务时退回隐藏 Agent 的 system+user 兼容路径
- 状态栏：通用解析 `<StatusBlock>` / `<Status>` / `<State>` / `【状态栏】` / `<UpdateVariable>` / `<Options>`
  - 默认只提取 `标签: 值`，不翻译、不猜语义、不认具体卡片
  - 卡级规则 `status_schema`（角色 `extensions.hdsh_status` 或世界书同名条目）可配置忽略字段、值替换、变量、进度/阶段、automations
- 设置：世界书预算、历史条数、回复 Token、扫描深度、递归层数、最少激活数、最大扫描深度、扫描带角色名、上下文总 Token、Persona、Prompt 顺序
- 单角色聊天：开场白、消息持久化、模型生成、流式（SSE）、重新生成
- **Swipe**：一条回复保存多个候选（`swipes[]` + `activeSwipe`），可追加/切换/删除；`<Options>` 只作为快捷回复，不再当 swipe
- **Continue**：从最后一条角色回复继续写，追加到同一条消息
- **Impersonate**：让模型以用户身份写一句，作为 user 消息插入
- **STscript 子集**：`/pass` `/echo` `/setvar` `/addvar` `/incvar` `/decvar` `/getvar` `/flushvar` `/inject`，供 Automation 与 `/script` 使用
- 群聊：多角色、`speaker` 记录、群聊 Prompt（**暂停投入**，仅保留可用实现）
- 消息：编辑、删除、从消息创建分支（保留群聊身份与状态栏/媒体元数据）、导出 Markdown/JSON
- 媒体：生图、语音；支持标签触发、明确要求触发和自然对话感知（`off` / `explicit` / `auto`）；`/tavern/media/*` 免 Cookie（见下）
- 数据：`<DSH_HOME>/tavern/data.json` 原子写；损坏文件自动备份为 `data.json.corrupt-*`；支持 JSON 备份（角色卡 / 聊天 / 世界书 / 设置）
- **上下文压缩（剧情记忆）**：最近 `historyLimit` 条逐字保留，更早的折叠成摘要存进 `chat.memory`，每轮注入 system 的 `【剧情记忆】`；支持手动 / 自动、增量合并、分块摘要、编辑与清空
- 同一聊天写入串行化，避免并发请求交错

## 上下文压缩（剧情记忆）

规则：

- `historyLimit`（App 设置，2~100，数的是**条**消息）之内的历史逐字保留；
- 更早的消息按块送摘要模型，合并成一段滚动摘要，存 `chat.memory`；
- 每轮拼 prompt 时摘要进 system（Prompt 顺序里的 `memory` 段，位于世界书之后、示例之前），逐字历史从摘要覆盖点之后开始；
- 原始消息一条不删，`data.json` 仍是完整记录；摘要只是发给模型的视图；
- 压缩后重置该对话的隐藏 Agent 会话，下一轮才会以「system + 摘要 + 尾部」重建上下文。

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/tavern/chats/:id/compact` | 手动压缩一次；body 可带 `keep`（临时逐字条数）、`userName` |
| `GET` | `/tavern/chats/:id/memory` | 当前摘要、覆盖消息 id、压缩日志、可折叠条数；可带 `?historyLimit=N` 按 App 的设置估算逐字窗口 |
| `PUT` | `/tavern/chats/:id/memory` | 手动改摘要（`{ summary }`，空串等于清除） |
| `DELETE` | `/tavern/chats/:id/memory` | 清除记忆，回到纯 `historyLimit` 截断 |

自动压缩配置（`cordis.patch.yml`，都可省略）：

```yaml
- id: tavern
  name: hdsh-tavern
  config:
    enabled: true
    memory:
      auto: true               # 关掉就只保留手动压缩
      ratio: 0.75              # prompt 超过预算的 75% 时提前压缩
      minFoldMessages: 8       # 少于这么多条不压
      foldTriggerMessages: 24  # 攒够这么多条未折叠消息就压一次
      summaryMaxTokens: 1200   # 单次摘要输出上限
      chunkMessages: 24        # 首次全量压缩时每块的条数
      chunkChars: 12000        # 每块的字符上限
      budgetTokens: 0          # 0 = 用 App 的「上下文总 Token」或模型窗口推算
```

说明：

- 预算优先级：App 传来的 `contextTokens` > `budgetTokens` > 模型窗口 − 输出上限 − 8k > 24000；
- 摘要模型优先用 `ctx.llm.stream`（不产生会话）；没有 `llm` 服务的旧版 DSH 会退回固定 id 的隐藏 Agent（`tavern-mem-<chatId>`，每个对话一条）；
- 摘要调用失败不会阻塞聊天：保留旧摘要，下一轮再试；
- 手动压缩必须持有该 chat 的写入锁，和发消息串行。该功能只处理单聊与群聊的同一套 `chat.messages`，群聊摘要保留 `角色名：` 前缀。


## 与 SillyTavern 仍有的差异

- **Prompt**：有 `ctx.llm` 时是真正的 messages 数组；没有 `llm` 服务的旧版 DSH 会退回单条 user 的 Agent 路径。
- **STscript 只有子集**：没有 `/if` / `/while` / `/gen` / `/send` / `/cut`、Quick Replies 面板和完整脚本运行时。
- **生成参数**：支持 `maxTokens` / `temperature` / `stop`；top_p / top_k / penalties / seed 仍受 DSH LLM 接口限制。
- 数据仍是单个 `data.json` 全量重写，不是每 chat JSONL。
- 角色卡的 `system_prompt` 作为附加 section，而不是覆盖主提示词。
- 条目的 `scanDepth = 0` 表示「用全局扫描深度」，而 ST 的 0 表示「不做关键词扫描」。
- 世界书没有向量匹配；`useGroupScoring`（按命中 key 数决定分组胜者）未实现。
- 群聊不是回合制：一次调用让模型写多人，暂不做静音/回复顺序。

## 状态栏规则（status_schema）

默认解析是通用的：任何 `标签: 值` 都会进入 `statusLines`，值保持原样。需要“截取数值 / 忽略字段 / 累计进度并显示阶段名”时，在角色卡里加：

```json
"extensions": {
  "hdsh_status": {
    "ignoreLabels": ["Time", "History check", "Dramatic updates"],
    "valueRules": [
      { "label": "攻略阶段", "pattern": ".*?([+-]\\d+(?:\\.\\d+)?).*", "replacement": "$1" }
    ],
    "progress": {
      "label": "攻略阶段",
      "initial": 0,
      "stages": [
        { "name": "陌生", "min": 0 },
        { "name": "熟悉", "min": 10 },
        { "name": "亲近", "min": 20 }
      ]
    }
  }
}
```

也可以把同样的 JSON 放进世界书条目：`comment` 或第一个 key 为 `status_schema`，内容为 JSON。
`progress.stages` 留空时，会尝试从世界书的 `stage_names_overview` / `category:` 自动推导阶段。
如果旧卡把状态写在 `<Analysis>` 里，加 `"parseAnalysis": true` 才会解析该块（默认只剥离）。
没有 schema 时不会做任何卡片专属翻译——这是和 ST 一致的行为（状态语义由卡/脚本负责）。

## 变量（variables）

世界书里可以声明变量，状态栏的 `标签: 值` 会自动映射到变量：

```json
{
  "variables": {
    "affection": {
      "label": "好感度",
      "aliases": ["好感"],
      "type": "number",
      "initial": 0,
      "min": 0,
      "max": 100,
      "unit": "",
      "stages": [
        { "name": "陌生", "min": 0 },
        { "name": "熟悉", "min": 10 },
        { "name": "亲近", "min": 20 }
      ]
    },
    "location": { "label": "地点", "type": "string", "initial": "家" }
  }
}
```

声明位置（后者覆盖前者）：

1. 世界书条目：`comment` 或第一个 key 为 `variables` / `variable_schema` / `变量`；
2. 角色扩展 `extensions.hdsh_status.variables`；
3. `status_schema.progress` 自动合成一个进度变量（阶段为空时从 `stage_names_overview` 推导）。

变量条目内容可以是 JSON，也可以是简单行（`好感度: 0 (0-100)`，括号里是 min~max）。

状态栏更新规则：

- `好感度: +3` → 累加；
- `好感度: 12` → 设为 12；
- `好感度: 熟悉` → 映射到该阶段的 `min`；
- 数值 clamp 到 `min/max`，显示为 `12 · 熟悉`。

变量会按 chat 持久化（`chat.variables`），并注入到 Prompt 的 `【当前变量】` 区；
世界书/Prompt 里可以用 `{{getvar::affection}}`（或 `{{getglobalvar::affection}}`）取当前值。
状态栏行会带 `key`（变量 id），App 仍按 `label/value` 展示。

## 媒体免鉴权说明

`GET /tavern/media/:name` **不校验 DSH Cookie**，这是刻意的：App 的 `Image`/音频组件加载媒体 URL 时无法附带 Cookie。补偿措施：

- 文件名是 `m_<uuid>.png|mp3`，不可枚举；
- 路由只允许这个文件名格式，不接受目录穿越；
- 插件不提供媒体目录列表接口；
- API Key 不落盘、不写日志。

如果以后 App 能带 Cookie 加载媒体，再给这个路由补 `admit()`。

## 未实现（后续）

- CHARX 资源、PNG V3 导出（当前导出只写 `chara`）
- 旧版 DSH 没有 `llm` 服务时仍退回 Agent 的单条 user 路径
- 世界书 `useGroupScoring`、向量匹配
- 完整 STscript（`/if` `/while` `/gen` `/send` `/cut`）与 Quick Replies UI
- 群聊回合制、静音、回复顺序策略（暂停投入）
- 上下文截断的 UI 提示（服务端已返回 `historyTrimmed` / `contextTruncated`）
- 每 chat JSONL + 写锁 + 版本迁移
- 状态栏规则的 App 可视化编辑器（当前写入卡片扩展或 `status_schema` 世界书条目）

## 明确不做

- **Persona Lorebook**：App 以角色卡绑定世界书，世界书里可以直接写 user 信息，不需要再给 persona 绑一本。
- **per-chat lore（独立 chat 世界书）**：对话继承角色卡绑定的世界书，同一角色换聊天不需要另一套 lore。
- **per-character model / preset**：统一使用 DSH 默认模型与全局 Prompt/生成设置，不做角色级覆盖。

## 数据

```text
<DSH_HOME>/tavern/
  data.json
  avatars/<characterId>.png
```

## API

```text
GET    /tavern/health
GET    /tavern/characters
POST   /tavern/characters
POST   /tavern/characters/import
POST   /tavern/characters/parse
POST   /tavern/characters/:id/avatar
GET    /tavern/characters/:id/avatar
GET    /tavern/characters/:id/export       ?format=json|png
GET    /tavern/characters/:id
PATCH  /tavern/characters/:id
DELETE /tavern/characters/:id
GET    /tavern/worlds
POST   /tavern/worlds
GET    /tavern/worlds/:id
PATCH  /tavern/worlds/:id
DELETE /tavern/worlds/:id
GET    /tavern/chats
POST   /tavern/chats
POST   /tavern/chats/group
GET    /tavern/chats/:id
DELETE /tavern/chats/:id
POST   /tavern/chats/:id/messages
POST   /tavern/chats/:id/messages/stream
PATCH  /tavern/chats/:id/messages/:mid
DELETE /tavern/chats/:id/messages/:mid
POST   /tavern/chats/:id/regenerate
POST   /tavern/chats/:id/swipe
POST   /tavern/chats/:id/swipe/select
POST   /tavern/chats/:id/swipe/delete
POST   /tavern/chats/:id/continue
POST   /tavern/chats/:id/impersonate
POST   /tavern/chats/:id/script
POST   /tavern/backup/export
POST   /tavern/backup/import
POST   /tavern/chats/:id/branch
GET    /tavern/chats/:id/export
GET    /tavern/media/:name
POST   /tavern/worlds/import
POST   /tavern/prompt/preview
```

## 数据备份

`POST /tavern/backup/export` 接收 `characterIds` / `chatIds` / `worldIds`，返回：

```json
{
  "format": "hdsh-tavern-backup",
  "version": 1,
  "exportedAt": 0,
  "characters": [],
  "worlds": [],
  "chats": []
}
```

`POST /tavern/backup/import` 接收同样的 bundle，导入时重新生成 id，不会覆盖本机数据；
聊天按角色映射重建，缺角色的聊天会跳过。App 的「设置 → 数据与备份」会额外带上 `settings`，
但**不会导出百炼 API Key 和本机头像路径**。

## Automation ID 与 STscript 子集

`status_schema.automations` 把世界书条目的 `automationId` 映射到动作：

```json
{
  "automations": {
    "enter_tavern": [
      { "action": "addvar", "key": "affection", "value": 2 },
      { "action": "inject", "id": "tavern_mood", "text": "酒馆里很吵。", "depth": 4, "role": 0 }
    ],
    "night_event": {
      "action": "script",
      "script": "/addvar key=affection 1 | /inject id=night 夜深了。"
    }
  }
}
```

支持动作：`setvar` / `addvar` / `incvar` / `decvar` / `inject` / `script`。
脚本子集：`/pass` `/echo` `/setvar` `/addvar` `/incvar` `/decvar` `/getvar` `/flushvar` `/inject`；
不支持 `/if` `/while` `/gen` `/send` / Quick Replies 等。也可以直接调用 `POST /tavern/chats/:id/script`。

## 语音与生图

回复里模型可以额外输出两段标记，插件解析后调用阿里百炼生成媒体，**主对话文字不受影响**：

```text
<media_image>画面描述</media_image>
<media_voice>要朗读的短句</media_voice>
```

- 生图用 `wan2.7-image`，语音用 CosyVoice（默认音色 `longanhuan_v3`）；
- API Key 由 App 在每次请求里带上（`apiKey`），插件不落盘、不写日志；没带 Key 时只返回文字；
- 每个角色每天的次数由请求里的 `imageLimit` / `voiceLimit` 控制（默认 3 / 5，上限 50）；
- 媒体文件保存在 `<DSH_HOME>/tavern/media/`，通过 `GET /tavern/media/:name` 取回；
- 流式对话里 `<media_image>` / `<media_voice>` 不会当成正文吐给 App；
- `autoMedia` 控制自然语言触发：`off` 只认标签，`explicit` 认“发张图/来段语音/看看你”，`auto` 还会识别“你现在的样子”以及角色回复里的“发来一张照片/一段语音”等叙述；默认 `explicit`，可在 App「语音与图片」页切换。

## 安装

插件是纯 Node ESM：没有 `dependencies`、没有原生模块、没有构建步骤，克隆仓库后直接安装。

```bash
git clone https://github.com/PawNzZi/hdsh-tavern.git

# Web 版（CLI profile）
dsh plugin --profile web add ./hdsh-tavern
dsh web
```

桌面版在「插件」页用插件管理器安装这个目录。装好后确认 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里出现 `hdsh-tavern`，然后**完全退出 DSH 再启动**。

## 相关链接

- 官网：<https://hdsh.lingyikz.cn/>
- HDSH 下载（HarmonyOS NEXT · 华为应用市场）：<https://appgallery.huawei.com/app/detail?id=cn.lingyikz.hdsh&channelId=SHARE&source=appshare>
- 插件源码：<https://github.com/PawNzZi/hdsh-tavern>
- 问题反馈：<https://github.com/PawNzZi/hdsh-tavern/issues>
- 同系列插件：[`hdsh-remote-pair`](https://github.com/PawNzZi/hdsh-remote-pair) · [`hdsh-whale-companion`](https://github.com/PawNzZi/hdsh-whale-companion)
