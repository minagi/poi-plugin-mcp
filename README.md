# poi-plugin-mcp (Minagi fork)

Poiで保持している艦隊・艦娘・装備・資源・任務などの情報を、ローカルHTTP APIと
[Model Context Protocol（MCP）](https://modelcontextprotocol.io/)経由で外部ツールから参照するためのPoiプラグインです。

サービスは既定で`127.0.0.1:17777`だけをlistenし、LANやインターネットへは公開しません。

## このforkについて

このrepositoryは、npmで公開された`poi-plugin-mcp` 0.2.29を基にしたforkです。
取り込み時点の内容はtag [`upstream-0.2.29`](https://github.com/minagi/poi-plugin-mcp/tree/upstream-0.2.29)、
元READMEは[docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)で確認できます。

- Fork maintainer: [Minagi Tohno](https://github.com/minagi)
- Repository: [minagi/poi-plugin-mcp](https://github.com/minagi/poi-plugin-mcp)
- Issues: [GitHub Issues](https://github.com/minagi/poi-plugin-mcp/issues)

主なfork後の変更は次のとおりです。

- MCP Toolを拡張し、艦隊状態、艦娘・装備検索、任務、戦闘、操作event、KCSAPI responseを取得可能にした
- 現在資源を名前付きfieldで返し、航海日誌の資源履歴を期間集計する`get_resource_history`を追加した
- 設定UIを日本語化し、各機能の用途と安全上の注意を表示した
- 外部Poiプラグインとのread-only連携基盤を追加した
- 航海日誌（`poi-plugin-akashic-records`）を任意連携として検出し、Poi Redux extension state経由で資源履歴を参照できるようにした
- HTTP MCPとstdio MCPで同じTool定義・入力検証・結果形式を利用するよう整理した

## 主な機能

- Poi storeにある艦隊、艦娘、装備、資源、任務、基地航空隊、master dataなどの参照
- 艦娘・装備の絞り込み、summary、keyset pagination
- 全任務tabから取得した任務snapshotの参照
- 現在または最後に観測した戦闘状態の参照
- 成功したゲームAPI操作eventと、完全一致pathで指定したKCSAPI responseの参照
- 航海日誌の資源snapshotを使った純増減、回復ペース、期間内の最小・最大、観測された増減の集計
- MCP Resources、HTTP MCP、stdio MCP、ローカルHTTP data endpoint
- 明示的に有効化した場合のみ利用できるWebView入力、調査用JavaScript実行、操作記録

## インストール

このforkとnpm版`poi-plugin-mcp`は同じpackage名です。Poiのプラグイン検索から
`poi-plugin-mcp`を通常installした場合は、npmで公開されているupstream版が対象となります。

このforkをGitHubからinstallする場合はPoiを完全に終了し、PowerShellで次を実行します。

```powershell
cd "$env:APPDATA\poi\plugins"
npm install "git+https://github.com/minagi/poi-plugin-mcp.git#v0.2.30-minagi.1"
```

install後にPoiを再起動し、プラグイン一覧で「MCP連携」が有効になっていることを確認してください。

Poiは同名npm packageの`latest`とlocal versionをSemVerで比較します。このforkはupstream
`0.2.29`より新しく、将来の正式版`0.2.30`よりは古くなるよう、`0.2.30-minagi.1`を使用します。
これによりupstream `0.2.29`を誤ってupdateとして表示することを避けつつ、upstream `0.2.30`
が公開された場合はupdate対象になります。update実行時はnpm registryの同名packageがinstall
されるため、forkを継続利用する場合は更新元を確認してください。

stdio接続で`poi-mcp`コマンドを利用する場合は、同じforkをglobal installできます。

```powershell
npm install -g "git+https://github.com/minagi/poi-plugin-mcp.git#v0.2.30-minagi.1"
Get-Command poi-mcp
```

## 設定

設定は`%USERPROFILE%\.poi-mcp\settings.json`へ保存されます。

| 項目 | 説明 |
|---|---|
| Port | HTTP/MCPサービスの待受port。既定値は`17777`。通常は変更不要 |
| Service | ローカルデータ連携サービスを開始・停止 |
| WebView Input | 認証済みクライアントからゲーム画面へ入力を送信。参照のみの利用では不要 |
| 操作記録 | 操作・画面・関連responseをローカルへ記録。入力の再生は行わない |
| Debug eval | ゲームWebViewで任意JavaScriptを実行する調査用機能。通常はOFFを推奨 |
| 航海日誌 | 航海日誌の資源履歴をread-onlyで利用。明示的にONにした場合だけ参照 |

航海日誌は必須dependencyではありません。未install・無効・読込未完了の場合でも、
航海日誌連携以外の機能は利用できます。

操作記録の保存内容、上限、redactionについては[操作記録の仕様](docs/RECORDING.md)を参照してください。

## MCP接続

### 起動確認とport

既定portのhealth check:

```powershell
Invoke-RestMethod http://127.0.0.1:17777/health
```

正常時は`{"status":"ok"}`を返します。実際に使用しているportは次のfileにも保存されます。

```none
%USERPROFILE%\.poi-mcp\port
```

root path `/`の404は異常ではありません。`/health`を使用してください。

### HTTP MCP

Poiが起動している状態で、MCP clientから次のURLへ接続します。

```none
http://127.0.0.1:17777/mcp
```

Codexの設定例:

```toml
[mcp_servers.poi]
url = "http://127.0.0.1:17777/mcp"
```

一般的なJSON設定例:

```json
{
  "mcpServers": {
    "poi": {
      "url": "http://127.0.0.1:17777/mcp"
    }
  }
}
```

### stdio MCP

`poi-mcp`は対話型commandではなく、MCP clientが起動するstdio serverです。
Poi内の既存HTTP `/mcp`へ委譲するため、Poiと本プラグインが起動している必要があります。

```toml
[mcp_servers.poi]
command = "poi-mcp"
args = []
```

commandが見つからない場合は`Get-Command poi-mcp`で得た完全pathを指定してください。

### MCP Resources

`resources/list`と`resources/read`では次のURIを利用できます。

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

### ローカルHTTP endpoint

主なread endpointは次のとおりです。

| Endpoint | 内容 |
|---|---|
| `GET /health` | bridgeのhealth check |
| `GET /basic` | 提督基本情報 |
| `GET /fleets` | 艦隊 |
| `GET /ships` | 所持艦娘instance |
| `GET /equipment` | 所持装備instance |
| `GET /resources` | 現在資源のraw 8要素配列 |
| `GET /quests` | 受注任務と任務進捗record |
| `GET /available-quests` | 全任務tabから取得したsnapshot。stdio内部でも使用 |
| `GET /airbase` | 基地航空隊 |
| `GET /names` | 艦娘・装備・遠征の名称map |
| `GET /master` | 艦娘・装備・艦種・遠征などのmaster data |
| `GET /event` | event札定義と所持艦娘の出撃札 |
| `GET /planner` | Ship Infoの配装計画data |
| `GET /battle` | 観測した戦闘data、結果、簡易状態 |
| `GET /action-events` | 成功したゲームAPI操作event |
| `GET /action-events/wait` | 新しい操作eventを待つlong-poll endpoint |
| `GET /api-responses` | 完全一致pathで指定したKCSAPI response |
| `GET /all` | 基本runtime dataのまとめ |
| `POST /query` | Bearer token必須の汎用read-only query |
| `GET /debug/status` | Bearer token必須のDebug eval状態確認 |
| `POST /debug/evaluate` | 明示的に有効化したDebug eval |
| `POST /mcp` | HTTP MCP JSON-RPC endpoint |

## MCP Tools

現在は12個のToolを公開します。

| Tool | 用途 |
|---|---|
| `get_fleet_status` | `fleetId` 1～4の艦隊、艦娘、装備、補強増設、速力、士気、33式索敵、制空値を取得 |
| `search_ships` | 所持艦娘を名前、master ID、艦種、level、士気、lock、配属艦隊、出撃札などで検索 |
| `search_equipment` | 所持装備を名前、master/type ID、改修値、lock、装備中かどうかで検索・集計 |
| `get_resources` | 現在の8資材を名前付きfieldと元のraw配列で取得 |
| `get_resource_history` | 航海日誌の資源snapshotを期間集計し、純増減、日次換算、最小・最大、観測された増減などを取得 |
| `get_quests` | Poi storeにある受注任務と進捗recordを取得 |
| `get_available_quests` | 「全任務」tabから最後に取得した新鮮な任務snapshotを検索・集計 |
| `get_airbase_status` | Poi storeの基地航空隊配列を取得 |
| `get_all` | 基本account dataをまとめて取得。通常は目的別Toolを推奨 |
| `get_battle` | 現在または最後に観測した1件の戦闘状態を取得 |
| `get_action_events` | 成功したKCSAPI操作eventをgeneration順に取得 |
| `get_kcsapi_responses` | 完全一致`apiPath`について、保持中のKCSAPI responseを取得 |

`search_ships`と`search_equipment`は最大200件のkeyset paginationに対応します。
装備の`summary:true`はpagination前の全一致対象を集計し、`limit`省略時はinstance一覧を
返さないため、MCP clientのcontext消費を抑えられます。`equipped`判定は艦娘の通常slotと
補強増設を対象とし、基地航空隊は対象外です。

`get_available_quests`は正常な`api_tab_id=0` responseだけを単一snapshotとして保持します。
snapshotは取得から5分、または次の05:00 JSTの早い方で失効し、任務操作や
bootstrap/reconnectを観測した場合もstaleになります。更新するにはゲームで「全任務」tabを
開くか再表示してください。Tool自身が任務を受注・解除することはありません。

`get_battle`は戦闘履歴ではありません。`in_progress`のまま残っていても古い可能性があります。
`poi-plugin-prophet`による予測は任意で、未installでもエラーにはなりません。

`get_action_events`と`get_kcsapi_responses`はin-memory ring bufferを参照します。
Poi再起動や保持上限超過は`sessionChanged` / `cursorLost`等で判別できます。
`get_kcsapi_responses`は完全一致pathだけを受け付け、requestの`postBody`は返しません。
response bodyとTool結果にはsize上限があり、省略時はmetadataで判別できます。

## 航海日誌連携

`get_resource_history`は航海日誌（`poi-plugin-akashic-records`）を任意のdata sourceとして
利用します。利用には次の条件がすべて必要です。

- 設定画面で航海日誌連携をONにしている
- 航海日誌がinstall・有効化され、Poiで正常に読込済み
- pluginがbrokenまたはrollback待ちではない

本プラグインは航海日誌の保存fileを直接読みません。航海日誌がPoiのRedux extension stateへ
読み込んだ`resource.data`をread-onlyで参照し、名前付きの内部形式へ正規化します。
航海日誌側のstate、file、設定を変更する処理はありません。

資源snapshotは固定timerで毎時必ず作られるものではありません。
航海日誌が`/kcsapi/api_port/port`を観測し、前回記録した時間帯から変わっている場合に、
1時間帯あたり最大1件保存されます。母港情報を取得しない時間帯は欠測し得ます。

`get_resource_history`は期間内の最古・最新snapshot、純増減、実観測期間による日次換算、
最小・最大、開始値からの最大減少、隣接snapshot間で観測された増加・減少を返します。
これはtransaction logではないため、`observedIncrease` / `observedDecrease`を実際の総収入・
総消費と解釈しないでください。返却されるsampling gap情報で長時間の欠測も確認できます。

資源回復、event期間、戦果稼ぎ期間、運用変更前後などの事実確認に利用できますが、
おすすめ遠征、予測、資源優先順位などの判断はTool側では行いません。

## セキュリティ上の注意

通常のread-only利用では、艦隊・艦娘・装備・資源・任務等の参照と、明示的にONにした
航海日誌連携を利用します。これらの結果にはaccount固有のinstance IDや進行状況が含まれる
場合があるため、信頼できるローカルclientだけから接続してください。

次の機能は通常の参照には不要で、設定画面から明示的に有効化する必要があります。

- **WebView Input**: ゲーム画面へ入力を送信する。Bearer tokenによる認証を使用
- **Debug eval**: ゲームWebViewで任意JavaScriptを実行する。token参照、game API呼出し、
  page変更等が可能なため、調査時だけONにし、終了後はOFFへ戻すことを推奨
- **操作記録**: mouse操作、画面、関連response、選択したPoi stateをlocal diskへ保存。
  再生機能ではなく、保存容量と記録内容を確認したうえで利用

`/query`、`/debug/status`、`/debug/evaluate`はCORSを公開せず、
`%USERPROFILE%\.poi-mcp\input-token`のBearer tokenを要求します。

## 開発・テスト

source checkoutで次を実行します。

```powershell
npm install
npm test
npm pack --dry-run --ignore-scripts
```

JavaScriptの構文確認例:

```powershell
$files = @(rg --files -g '*.js')
foreach ($file in $files) { node --check $file }
```

## Upstream

- 取り込み元: npm版`poi-plugin-mcp` 0.2.29
- Snapshot tag: [`upstream-0.2.29`](https://github.com/minagi/poi-plugin-mcp/tree/upstream-0.2.29)
- Upstream README保存版: [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)

取り込んだsnapshotにはupstream repository URL、author、copyright holderを確実に特定できる
情報が含まれていません。そのため、npm publisher名やGitHub usernameから推測した作者・
著作権者は記載していません。

## License

`package.json`のlicenseは、upstream 0.2.29と同じ`MIT`を維持しています。
[LICENSE](LICENSE)はMinagi forkで追加・変更した部分についてのcopyright noticeを伴う、
標準MIT License本文です。

upstream snapshotも`package.json`でMITを宣言していますが、snapshot内にLICENSE fileや
copyright holder・yearの明記はありませんでした。確認できた事実とfork側noticeの範囲は
[NOTICE.md](NOTICE.md)へ分離しています。元の著作権者をMinagi Tohnoとして扱うものではなく、
このrepositoryでは不明なupstream holderを推測していません。
