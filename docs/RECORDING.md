# 操作記録（Record play）の仕様

この文書は、poi-plugin-mcp (Minagi fork)の操作記録機能が保存する内容と制限を説明します。

## 概要

設定画面の「操作記録」は既定で無効です。有効にすると自動待機状態になり、ゲームWebViewの
mouse eventを監視します。待機しただけでは空のsessionやscreenshotを作成しません。

- 最初のゲームWebView上のmouse操作でsessionを開始する
- mouse eventが5分間なければ現在のsessionを終了する
- 終了後、次のmouse操作で新しいsessionを開始する
- 設定をOFFにすると待機を解除し、進行中のsessionを終了する

入力を妨げたり、記録した入力を再生したりする機能ではありません。通常はgame runtime objectを
走査せず、未知のgetterやsort functionをwrapしません。

Windowsでの既定保存先:

```none
D:\poi-mcp\recordings
```

## Mouse操作の記録

- mouse移動eventがなく、押下位置からの移動が6 WebView pixel未満の場合は`click`として記録する。
  screenshot処理でmouse upが遅れてもholdへ誤分類せず、押下時screenshotと元の`durationMs`を保存する
- 移動が6 pixel以上の場合は`drag`として記録し、開始・終了screenshotと押下中の有界な軌跡を保存する
- mouse移動eventがあり、移動が6 pixel未満で200 msを超えて押下した場合は`hold`として記録し、
  開始・終了screenshotを保存する
- buttonを押していないmouse moveは保存しないため、通常のhoverだけでは記録を作らない

## 操作に付随するstate

各mouse up後のおよそ0、250、1000 msに、次の情報を保存します。

- 装備instance IDのmember集合
- 艦娘slotの並び
- 艦隊の並び

装備instance IDの集合だけではgame UI上の表示順を表しません。加えて、次の装備UI stateを
同期的に確認します。

- `listMode`
- `slotItemFilter`
- `slotItemFilterDetail`
- `slotItemPage`

session開始・終了時には、Poiが保持している装備masterから`api_type`、`api_sortno`、名称を
抜粋して保存します。これはofflineで装備候補順を再構成するための参照情報です。

game client上で直接参照でき、確実に復元できる対象が確認されない限り、runtime全体の探索や
sorterのwrapは行いません。

## Response・storageの記録

- Poiの`game.response`に流れたpath、request parameter、response JSONを保存し、配列順を維持する
- `*.kancolle-server.com`のgame frameにある`localStorage` / `sessionStorage`について、
  keyと変更hashだけを保存する
- DMM外側page、広告、tracking frameはstorage収集対象外
- 装備UIの4 state fieldだけを平文保存する
- 一般値はsessionごとに異なるHMACで表現する
- sensitive key、またはsensitive fieldを含むJSONは値もhashも保存しない
- Cookie、CacheStorage、IndexedDBは読み取らない

装備順序を調査するときは、次の情報を区別する必要があります。

- `game.response`内の配列順は、そのresponseが返した順序
- `equipmentMembershipIds`とPoi `info.equips`のobject keyは、現在の装備member集合
- game clientは独自にfilter、sort、paginationを行う
- 現在の静的参照では通常装備順に`equipTypeSp → master ID → instance ID`が関係し、
  改修filterでは改修値の昇順・降順も加わる
- KCVの`AssistantEquipRules`は独自の候補順を再構成するため、game UI順の根拠にはできない

装備操作の示教では、装備pageを開く、filter・sortを変更する、pageを移動する、装備を選択する、
という一連の操作と、その前後のscreenshot・filter/page state・Poi response・master参照を残すと、
game rendererを実行中に広範囲探索せずofflineで証拠を照合できます。

## Session構成

主な保存内容:

```none
manifest.json
events.jsonl
frames/
responses/
states/
storage/
checkpoints/
```

`states/session-start.json`と`session-stop.json`には、選択したPoi `info` / `sortie` stateと、
装備順序の参照に必要な最小限のmaster情報だけを保存します。

## Redaction

名前に`token`、`cookie`、`authorization`、`secret`、`password`などを含むfield、header、
storage keyは`[REDACTED]`として保存します。

`api_sort_key`、`sort_key`、`sortKey`、`shipSortKeyType`はgame上のsort指定であるため、
secretとして扱わず元の値を保存します。URL query stringは除去し、平坦な`rawHeaders`も
key/value pairとしてredactします。

## 保存上限

1 sessionの既定上限:

- 合計8 GiB
- timeline event 20,000件
- 実時間4時間
- screenshot 1枚16 MiB

4時間上限には実時間のdeadline timerを使用します。いずれかの上限に達すると収集を終了し、
session listenerを解除し、最終manifestを書き込み、設定画面に終了理由を表示します。

記録root全体の既定上限:

- 最大200 session
- 合計64 GiB

root上限に達した場合は新しいsessionの開始を拒否し、古い記録を自動削除しません。
不要になった記録は、内容を確認してから利用者自身で整理してください。
