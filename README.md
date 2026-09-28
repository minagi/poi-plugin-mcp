# poi-plugin-mcp

`poi-plugin-mcp` 是运行在 Poi 内的本地数据桥。它把当前舰队、舰娘、装备、
资源、任务、陆航和相关主数据通过本机 HTTP 与 MCP 提供给本机工具。

默认监听：

```none
http://127.0.0.1:17777
```

服务只绑定本机回环地址 `127.0.0.1`，不对局域网或公网监听。本文介绍用于
读取 Poi 状态的 MCP 工具、MCP 资源和 HTTP 数据端点。

## 安装与重启

在 Poi 插件管理器中安装 npm 包：

```none
poi-plugin-mcp
```

也可以完全退出 Poi 后，在 Poi 插件目录中手动安装：

```powershell
cd "$env:APPDATA\poi\plugins"
npm install poi-plugin-mcp
```

安装或更新后完整退出并重新启动 Poi。在插件设置中确认“`MCP 数据桥`”已启用，
然后进入游戏；需要读取账号数据的端点要等 Poi store 初始化完成。

如果 MCP 客户端要使用 stdio 方式，可另外全局安装同一个 npm 包，使
`poi-mcp` 命令进入 `PATH`：

```powershell
npm install -g poi-plugin-mcp
Get-Command poi-mcp
```

## 健康检查与端口发现

默认端口的检查命令：

```powershell
Invoke-RestMethod http://127.0.0.1:17777/health
```

正常响应：

```json
{"status":"ok"}
```

插件启动后会把实际端口写入：

```none
%USERPROFILE%\.poi-mcp\port
```

修改过端口时，应以该文件为准：

```powershell
$port = (Get-Content "$HOME\.poi-mcp\port" -Raw).Trim()
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

根路径 `/` 返回 404 不代表服务故障，请使用 `/health`。

## 本地操作示教记录

插件设置中的 `Record play` 默认关闭。打开后进入自动待命：插件只挂接游戏
WebView 的鼠标观察器，不会立即创建空会话。首次游戏鼠标活动会自动开始录制；
连续 5 分钟没有游戏 WebView 鼠标事件时自动结束当前会话，之后的下一次鼠标活动
会再开一个会话。关闭开关会立即解除待命并结束正在录制的会话。

观察器不会阻止或回放输入，也不会扫描或包裹游戏运行时对象。Windows 默认写入
D 盘，不经过用户目录或 OneDrive：

```none
D:\poi-mcp\recordings
```

记录规则：

- 没有收到移动事件且位移小于 6 个 WebView 像素：记为 `click`，即使截图导致鼠标
  抬起事件延迟也不会误记为长按；保存按下时截图并保留原始 `durationMs`。
- 位移达到 6 像素：记为 `drag`，保存开始、结束截图与按住期间的有界轨迹。
- 收到移动事件、位移不足 6 像素且按住超过 200 ms：记为 `hold`，保存开始、结束
  截图。
- 不记录未按键时的鼠标移动，因此普通悬停不会产生记录。
- 每次松开后约 0、250、1000 ms 保存装备成员 ID、舰娘槽位顺序和舰队顺序；装备
  成员 ID 不能代表 UI 顺序。
- 同步探测 `listMode`、`slotItemFilter`、`slotItemFilterDetail`、`slotItemPage`；
  会话开始和结束时另存 Poi 当前装备 master 的 `api_type`、`api_sortno` 与名称，
  供离线重建装备候选顺序。
- 默认不会扫描游戏对象图、调用未知 getter 或包裹游戏排序函数。只有在确认一个
  可直接访问且可恢复的运行时目标后，才应另行启用精确 sorter 观测。
- 同步保存 Poi 的 `game.response` 路径、请求参数和响应 JSON；数组保持原始顺序。
- 只对 `*.kancolle-server.com` 游戏 frame 的 `localStorage`、`sessionStorage`
  保存键和变化哈希，排除 DMM 外层页面、广告和追踪 frame。只有四个装备 UI 状态
  字段会保存明文；普通值使用每个会话独立的 HMAC，敏感键或含敏感字段的 JSON
  既不保存值，也不保存哈希。

装备顺序需要把不同证据分开看：

- `game.response` 中的数组只代表该响应的原始顺序。
- `equipmentMembershipIds` 和 Poi `info.equips` 的对象键只代表当前装备成员关系。
- 游戏客户端会自行过滤、排序并分页；当前静态参考显示普通装备顺序主要由
  `equipTypeSp → master ID → instance ID` 决定，改修筛选还会加入星级升/降序。
- KCV 的 `AssistantEquipRules` 会重建自己的候选顺序，不能当作游戏 UI 顺序。

因此一次装备示教应至少包含：打开装备页、改变筛选/排序、翻页、选中装备，并保留
相邻截图、筛选/分页状态、Poi 响应和开始/结束 master 参考。之后可以离线对齐这些
证据，而不需要在游玩时对游戏 renderer 做全局探测。

会话主要包含：

```none
manifest.json
events.jsonl
frames/
responses/
states/
storage/
checkpoints/
```

包含 `token`、`cookie`、`authorization`、`secret`、`password` 等名称的字段、header
或存储键会写为 `[REDACTED]`；`api_sort_key`、`sort_key`、`sortKey` 和
`shipSortKeyType` 是游戏业务排序字段，会保留原值。URL 查询串会移除，扁平
`rawHeaders` 也会按键值对脱敏。录制器不会读取 Cookie、CacheStorage 或 IndexedDB。
`states/session-start.json` 与 `session-stop.json` 只包含选定的 Poi `info` 和
`sortie` 状态及装备排序所需的精简 master 参考。

单个会话默认最多写入 8 GiB、20,000 条时间线事件、运行 4 小时，单张截图最多
16 MiB；4 小时使用真实截止定时器。达到任一限制后会结束采集、解绑会话监听、写完
最终 manifest，并在插件设置中显示原因。录制目录默认还限制为最多 200 个会话、
合计 64 GiB；达到总量时拒绝开始新会话，不会自动删除旧录制。自动待命观察器本身
不写截图或空会话，只有真实游戏鼠标活动才会占用录制空间。

## MCP 接入

插件提供两种 MCP 连接方式：

- **HTTP MCP**：客户端直接连接 Poi 内的 `POST /mcp`。
- **stdio MCP**：客户端启动 npm 安装的 `poi-mcp` 命令；该命令读取端口文件，
  再访问 Poi 的本地数据 API。

两种方式都要求 Poi 正在运行且插件已加载。

### HTTP MCP

MCP URL：

```none
http://127.0.0.1:17777/mcp
```

这是 JSON-RPC over HTTP 端点，请由 MCP 客户端向它发送 `POST` 请求。Codex
配置示例：

```toml
[mcp_servers.poi]
url = "http://127.0.0.1:17777/mcp"
```

使用 JSON 配置的 MCP 客户端可采用：

```json
{
  "mcpServers": {
    "poi": {
      "url": "http://127.0.0.1:17777/mcp"
    }
  }
}
```

若修改过端口，请把 URL 中的 `17777` 替换为端口文件中的值。

### stdio CLI

`poi-mcp` 是 MCP stdio 服务命令，不是交互式终端程序。MCP 客户端应负责启动
并通过标准输入输出与它通信。

Codex 配置示例：

```toml
[mcp_servers.poi]
command = "poi-mcp"
args = []
```

通用 JSON 配置示例：

```json
{
  "mcpServers": {
    "poi": {
      "command": "poi-mcp",
      "args": []
    }
  }
}
```

如果桌面客户端找不到 npm 的全局命令，请先运行 `Get-Command poi-mcp`，再把
配置中的 `command` 改为返回的完整可执行文件路径。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `get_fleet_status` | 按 `fleetId`（1-4）读取一支舰队：舰名、装备、补强、速度、士气、33式索敌（Cn 1–4）、制空。看一队时不要用 `get_all` |
| `search_ships` | 按可选的 `minLevel`、`maxLevel`、`minMorale` 筛选持有舰娘 |
| `search_equipment` | 按可选的 `minLevel` 筛选持有装备 |
| `get_resources` | 读取具名资源。Poi 数组下标 4=高速建造材（喷火）、5=高速修复材（桶）。HTTP `/resources` 仍是 8 元数组 |
| `get_all` | 整包账号转储。优先 `get_fleet_status` / `search_*` / `get_resources`；`include` 可选 `master`、`event`、`planner` |

## MCP 资源

可通过 `resources/list` 和 `resources/read` 读取：

```none
poi://basic
poi://fleets
poi://ships
poi://equipment
poi://resources
poi://quests
poi://airbase
poi://names
poi://master
poi://event
poi://planner
poi://all
```

## 数据端点

主要的本地 HTTP 数据查询端点：

| 端点 | 内容 |
|---|---|
| `GET /health` | bridge 健康状态 |
| `GET /basic` | 提督基础信息 |
| `GET /fleets` | 舰队数据 |
| `GET /ships` | 持有舰娘实例 |
| `GET /equipment` | 持有装备实例 |
| `GET /resources` | 当前资源 |
| `GET /quests` | 当前任务与任务记录 |
| `GET /airbase` | 基地航空队 |
| `GET /names` | 舰娘、装备和远征名称映射 |
| `GET /master` | 舰娘、装备、类型、远征等主数据 |
| `GET /event` | 活动标签定义与持有舰娘出击标签 |
| `GET /planner` | Ship Info 配装规划数据 |
| `GET /battle` | 已观测战斗数据、结算与简化战斗状态 |
| `GET /action-events` | 已捕获的成功游戏 API 动作事件（支持 `after` / `limit` 游标） |
| `GET /action-events/wait` | 有新动作时立即返回，否则在 `timeoutMs`（1-60000）内事件驱动等待；超时返回 `timedOut: true` 心跳 |
| `GET /all` | 基础运行数据汇总 |
| `POST /query` | 带 Bearer token 的通用只读查询：Poi store、任意已捕获 kcsapi、Poi JSON 缓存、游戏 frame/storage/属性路径 |
| `GET /debug/status` | 带 Bearer token 读取危险 WebView eval 开关状态 |
| `POST /debug/evaluate` | 仅在设置中显式开启后运行受大小限制的 WebView JavaScript 调试代码 |
| `POST /mcp` | HTTP MCP JSON-RPC 入口 |

`/query`、`/debug/status` 和 `/debug/evaluate` 不开放 CORS，响应禁止缓存，并要求
`%USERPROFILE%\.poi-mcp\input-token` 中的 Bearer token。`/query` 是正式数据面：
调用方提交 `source + path + filter`，Bridge 保持通用取数、限量和脱敏，新增缓存字段
通常不需要修改插件。

插件设置中的 `Debug eval` 默认关闭。打开后，认证调用方可以在经过
`*.kancolle-server.com` origin 校验且由 `processId:routingId` 明确指定的游戏 frame
内执行任意 JavaScript。它能够读取令牌、调用游戏接口、修改页面，也可能因同步死循环
卡住游戏 renderer；异步超时不能撤销已经发生的副作用。因此只用于发现未知运行时
路径，调试结束后应关闭，正式自动化必须改用 `/query` 或固定快照端点。审计日志只保存
脚本 SHA-256、frame、时间和成功/失败，不保存脚本文本。

## 开发验证

在源码目录执行：

```powershell
npm install
npm test
npm pack --dry-run --ignore-scripts
```

`npm test` 应运行 `node --test test/*.test.js`；打包预览应包含
`index.js`、`lib`、`mcp-server.js` 和本 README。
