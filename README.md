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

## 設定画面

Poiのプラグイン設定では、次の項目を変更できます。設定値は従来どおり
`%USERPROFILE%\.poi-mcp\settings.json` に保存されます。

- `Port` / `ポート`: HTTP/MCPサービスが使用するローカルポート。既定値は
  `17777`。変更時はMCPクライアント側の接続先も変更する。
- `Service` / `サービス`: ローカルデータ連携サービス全体を開始・停止する。
- `WebView input` / `WebView入力`: 認証済みのローカルクライアントからゲーム
  WebViewへ入力を送る。参照のみの利用では不要。
- `Record play` / `操作記録`: ゲーム操作・画面・関連レスポンスをローカルに記録
  する。入力を再生する機能ではない。
- `Debug eval` / `デバッグ実行`: 認証済みの任意JavaScriptをゲームWebViewで実行
  する調査専用機能。通常は無効のままにする。

外部プラグイン連携には、航海日誌（`poi-plugin-akashic-records`）の検出状態と、
将来の読み取り専用連携を利用するかどうかの設定を表示します。このバージョンでは
検出と設定保存だけを行い、航海日誌のstate・履歴ファイル・資源履歴は読みません。
航海日誌は任意プラグインであり、未導入または無効でも既存機能に影響しません。

保存形式は将来の連携追加に備えて入れ子になっています。

```json
{
  "integrations": {
    "akashicRecords": {
      "enabled": false
    }
  }
}
```

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
HTTP MCP 与 stdio MCP 共用同一套工具定义、搜索和结果整形。相同工具和输入应返回
语义相同、结构相同的结果。

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
| `search_ships` | 筛选持有舰娘，并以实例 ID 做 keyset 分页 |
| `search_equipment` | 筛选或汇总持有装备，并以实例 ID 做 keyset 分页 |
| `get_resources` | 名前付きの資源情報を取得。順序は燃料、弾薬、鋼材、ボーキサイト、高速建造材、高速修復材、開発資材、改修資材。HTTP `/resources` は従来どおり8要素のraw配列 |
| `get_quests` | 返回 Poi store 持有的受注任务 `activeQuests` 与任务进度 `records`；不是当前出现的全部任务列表 |
| `get_available_quests` | ゲームの「全任務」タブから最後に取得した新鮮な任務一覧。未受注・受注中・達成済みを含む |
| `get_airbase_status` | 原样返回 Poi store 的基地航空队数组，不补充名称；包装为 `{ source, enriched: false, airbase }` |
| `get_all` | 整包账号转储。优先 `get_fleet_status` / `search_*` / `get_resources`；`include` 可选 `master`、`event`、`planner` |
| `get_battle` | Poiが現在または最後に保持している単一の戦闘状態を取得。戦闘履歴ではなく、Prophet予測は任意 |
| `get_action_events` | 成功したKCSAPI操作イベントをgeneration順に取得。`after` / `sessionId` / `limit`に対応 |
| `get_kcsapi_responses` | 必須の完全一致`apiPath`について、保持中のKCSAPIレスポンスを安全なサイズで取得 |

`search_ships` 可组合使用 `name`、`masterId` / `masterIds`、`stype` / `stypes`、
`minLevel` / `maxLevel`、`minMorale` / `maxMorale`、`locked`、`inFleet`、
`fleetId`、`sallyArea`、`hasExpansion`、`limit`、`cursor`。不同条件之间是 AND；
同一 ID 条件的单数与复数形式取并集。`fleetId` 隐含 `inFleet:true`，不能与
`inFleet:false` 同时指定。名称会 trim、做 Unicode NFC 规范化，并以不区分大小写
的普通子串匹配，不使用正则表达式。

`search_equipment` 可组合使用 `name`、`masterId` / `masterIds`、`typeId` /
`typeIds`、`minLevel` / `maxLevel`（0–10）、`locked`、`equipped`、`limit`、
`cursor`、`summary`。其单复数 ID 条件也取并集，其余条件使用 AND。默认
`limit` 为 100，上限为 200；`search_ships` 采用相同的默认值和上限。

`summary:true` 会在分页前对全部匹配装备计算 `total`、锁定/未锁定数、装备中/
未装备数、按改修值计数以及按 master ID 分组的同类统计。未明确指定 `limit` 时，
`limit` 默认为 0 且 `equipment` 返回空数组，避免向模型发送全部实例；明确指定
1–200 时可同时取得汇总和一页实例。`summary:false` 时不能使用 `limit:0`。

`equipped` 和 `equippedOn` 只检查舰娘 `api_slot` 中的正实例 ID 及 `api_slot_ex`
中的正实例 ID。补强增设的 0 表示未开孔、负值表示已开孔但为空。基地航空队不在
判定范围内，因此 `equipped:false` 只表示装备不在舰娘普通槽或补强增设中，不能
解释为包含基地航空队在内的“完全未使用”。结果中的 `equippedScope` 会明确返回：

```json
{
  "normalShipSlots": true,
  "expansionSlots": true,
  "airbase": false
}
```

两种搜索都按实例 ID 升序返回，`cursor` 是包含版本、工具名、上一实例 ID 与规范化
筛选哈希的不透明 base64url 值。修改筛选条件或把 cursor 用于另一工具会得到输入
错误；`limit` 与 `summary` 不参与筛选哈希。数据来自实时 Poi store，分页期间若
持有数据发生变化，不保证得到完整 snapshot。

`get_available_quests` は、KCSAPI `api_get_member/questlist` のうち
`api_tab_id=0`（全任務タブ）の正常な最新レスポンスだけを単一snapshotとして保持する。
画面内のページ送りはクライアント側表示であり、ページ別・個別タブ別のcacheは作らない。
返却対象はゲームがその時点で表示した未受注（state 1）、受注中（state 2）、達成済みで
報酬受領待ち（state 3）の任務である。条件未達で表示されない任務、過去の任務履歴、
全master任務一覧は含まない。Poi storeの受注任務と進捗記録を返す既存`get_quests`とは
用途が異なる。

snapshotは取得から5分、または次の05:00 JSTの早い方で失効する。任務の受注・解除・
報酬受領、およびゲームのbootstrap/reconnectを観測した場合も直ちにstaleとなる。
staleまたは未取得の場合は古い任務本文を返さず、`available:false`、空の`quests`、
`refreshHint`を返す。更新するにはゲームで「全任務」タブを開くか再表示する。
ToolがWebViewを操作したり、任務を自動受注・解除・完了したりすることはない。

入力は`questId` / `questIds`、`state` / `states`、`type` / `types`、`category` /
`categories`、`invalidFlag` / `invalidFlags`、`limit`、`cursor`、`summary`に対応する。
異なる種類のfilterはAND、同じ種類の単数形と複数形は和集合である。通常の`limit`は
既定50・最大100。`summary:true`で`limit`を省略するとsummary-onlyとなり、明示した
場合はsummaryと任務pageを同時に返す。summaryはpagination前の一致集合をstate、type、
category、invalidFlag別に集計する。cursorはsession、snapshot generation、最後のquest ID、
filter hashを含むopaque base64urlで、snapshot更新後は先頭から取得し直す必要がある。
TTLまたは05:00 JST到達で途中pageが失効した場合はcursor errorではなくstale結果を返す。

stdio MCP 的 `get_resources` 返回值采用与 HTTP MCP 相同的具名对象；原始8元数组
仍完整保存在 `.raw`。这与旧版stdio MCP直接返回raw数组的形式不兼容。

`get_battle` はbattle historyではなく、Poiが現在または最後に保持した1件の戦闘状態を
返す。`status: "in_progress"` が残っていても、戦闘結果を捕捉できなかった場合などは
現在戦闘中とは限らず、staleな可能性がある。`poi-plugin-prophet` の予測は任意であり、
Prophetが存在しないことはエラーではない。

`get_action_events` はin-memory ring bufferからgeneration昇順で返す。`after` の既定値は
0、`limit`は既定20・最大64。レスポンスの`sessionId`を次回入力へ渡すと、Poiプロセス
再起動などによる`sessionChanged`を検出できる。`cursorLost`は、session変更、未来cursor、
または指定した`after`より新しいeventの一部が256件のring bufferから脱落したことを示す。
cursor lossと空結果はいずれも正常レスポンスである。長時間待機する
`/action-events/wait`はMCP Toolとして公開しない。

`get_kcsapi_responses` の`apiPath`は必須で、`/kcsapi/`から始まる完全一致pathだけを受け付ける。
prefix・substring・regex・wildcard検索は行わない。`after`の既定値は0、`limit`は既定3・
最大10。requestの`postBody`はMCP結果へ一切含めない。各`responseBody`はJSONで256 KiB、
Tool結果全体は1 MiBを上限とし、超過するbodyだけをnullにして`bodyOmitted: true`とする。
entry metadataは残り、buffer保存時点で既に切り詰められた場合は`storageTruncated: true`で
区別される。path filterはglobal generationを共有するため、`cursorLost: true`は脱落範囲に
指定pathのresponseも含まれていた可能性を示し、実際の脱落を断定するものではない。
raw KCSAPI dataには艦娘・装備instance IDなどアカウント固有情報が含まれ得る。
汎用`POST /query`、WebView storage/path/find、long-pollは通常MCP Toolへ公開しない。

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
| `GET /available-quests` | 全任務タブから捕捉したcanonical snapshot（stdio MCP内部用、読み取り専用） |
| `GET /airbase` | 基地航空队 |
| `GET /names` | 舰娘、装备和远征名称映射 |
| `GET /master` | 舰娘、装备、类型、远征等主数据 |
| `GET /event` | 活动标签定义与持有舰娘出击标签 |
| `GET /planner` | Ship Info 配装规划数据 |
| `GET /battle` | 已观测战斗数据、结算与简化战斗状态 |
| `GET /action-events` | 已捕获的成功游戏 API 动作事件（支持 `after` / `limit` 游标） |
| `GET /action-events/wait` | 有新动作时立即返回，否则在 `timeoutMs`（1-60000）内事件驱动等待；超时返回 `timedOut: true` 心跳 |
| `GET /api-responses` | 捕捉済みKCSAPIレスポンス（`after` / `limit` / 完全一致`path`） |
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
