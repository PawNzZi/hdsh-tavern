# hdsh-tavern

独立的 SillyTavern 兼容酒馆插件，与 `hdsh-whale-companion` 完全隔离。

## 边界

- 数据目录：`<DSH_HOME>/tavern`，不读写鲸鱼娘的 `whale-companion` 数据。
- Agent：独立 `tavern-roleplay` 预设；预设 `plugins` 为空，不挂 shell、文件、命令、MCP。
- API：`/tavern/*`，不复用 `/companion/*`。
- 人格：角色卡和世界书只作为上下文，不是可执行指令。

## P0 功能

- 角色卡：列表、创建、编辑、删除
- 导入：JSON（V1/V2/V3）、PNG（tEXt `ccv3`/`chara`）
- 角色卡内嵌 `character_book` 自动转世界书
- 世界书：列表、创建、条目增删改、关键词/常驻/顺序
- 单角色聊天：开场白、消息持久化、模型生成
- 世界书注入：最近消息关键词扫描、常驻、顺序、字符预算
- App：版本号 10 连击解锁，会话页鲸鱼娘旁入口

## P1 功能

- 世界书递归、深度注入、顺序/位置、分组竞争、概率、sticky/cooldown/delay
- Prompt 检查器：激活条目、System、User、预算截断
- 导入预览：解析角色卡与内嵌世界书后再确认导入
- 角色卡：备用开场白、作者备注、头像更换
- 聊天：消息编辑/删除/重新生成、从消息创建分支、导出 Markdown
- App：滑动玻璃胶囊 Tabbar、四 Tab 微信式布局、User 名称/头像

## 未实现（P2）

- CHARX/BYAF、PNG 导出
- 群聊、Persona、swipe
- 流式输出
- Prompt Manager 可视化自定义排序、精确 token 计数
- 世界书向量检索/TTS

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
GET    /tavern/chats/:id
DELETE /tavern/chats/:id
POST   /tavern/chats/:id/messages
POST   /tavern/chats/:id/messages/stream
PATCH  /tavern/chats/:id/messages/:mid
DELETE /tavern/chats/:id/messages/:mid
POST   /tavern/chats/:id/regenerate
POST   /tavern/chats/:id/branch
GET    /tavern/chats/:id/export
GET    /tavern/media/:name
POST   /tavern/worlds/import
POST   /tavern/prompt/preview
```

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
- 流式对话里 `<media_image>` / `<media_voice>` 不会当成正文吐给 App。

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
