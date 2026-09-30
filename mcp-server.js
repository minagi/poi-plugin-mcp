#!/usr/bin/env node
// poi-mcp — MCP Server for KanColle game data
//
// 两种使用方式:
//   方式 A: 配合 POI DevTools 脚本 (推荐, 最稳定)
//   方式 B: 配合 POI 的 --remote-debugging-port
//
// ── 快速开始 ──
// 1. 启动 POI，进入游戏母港
// 2. POI 菜单 → 开发工具 → 切换开发工具 (F12)
// 3. 在 Console 中粘贴下面这段脚本:
//
//    fetch('https://raw.githubusercontent.com/your/poi-plugin-mcp/main/inject.js')
//      .then(r => r.text())
//      .then(eval)
//
// 4. 脚本会自动启动 HTTP 服务并写入端口号到 ~/.poi-mcp/port
// 5. 然后运行: node mcp-server.js
//
// ── 备用方案: 粘贴下面脚本到 Console ──
// (function(){
//   var port = 17777;
//   var http = new XMLHttpRequest();
//   http.open('GET', 'http://127.0.0.1:' + port + '/health', true);
//   http.onload = function() {
//     if (http.status === 200) console.log('[poi-mcp] Server already running on port', port);
//   };
//   http.send();
//   var s = document.createElement('script');
//   s.src = 'data:text/javascript,' + encodeURIComponent([
//     'var p='+port+';',
//     'var gs=function(){return window.getStore()};',
//     'var s=require("http").createServer(function(q,r){',
//     '  r.setHeader("Access-Control-Allow-Origin","*");',
//     '  r.setHeader("Content-Type","application/json");',
//     '  var u=q.url;',
//     '  if(u==="/health"){r.end('+JSON.stringify(JSON.stringify({status:"ok"}))+')}',
//     '  else if(u==="/fleets"){r.end(JSON.stringify(gs().info.fleets))}',
//     '  else if(u==="/ships"){r.end(JSON.stringify(gs().info.ships))}',
//     '  else if(u==="/equipment"){r.end(JSON.stringify(gs().info.equips))}',
//     '  else if(u==="/resources"){r.end(JSON.stringify(gs().info.resources))}',
//     '  else if(u==="/quests"){r.end(JSON.stringify({activeQuests:gs().info.quests.activeQuests,records:gs().info.quests.records}))}',
//     '  else if(u==="/airbase"){r.end(JSON.stringify(gs().info.airbase))}',
//     '  else if(u==="/basic"){r.end(JSON.stringify(gs().info.basic))}',
//     '  else if(u==="/all"){r.end(JSON.stringify(gs().info))}',
//     '  else{r.writeHead(404);r.end("Not found")}',
//     '});',
//     's.listen(p,"127.0.0.1",function(){',
//     '  require("fs").writeFileSync("'+require('path').join(os.homedir(),'.poi-mcp','port').replace(/\\/g,'/')+'",String(p),"utf8");',
//     '  console.log("[poi-mcp] API running on http://127.0.0.1:"+p);',
//     '});'
//   ].join(''));
//   document.head.appendChild(s);
// })();

const os = require('os')
const path = require('path')
const fs = require('fs')
const http = require('http')
const packageJson = require('./package.json')
const {
  MCP_TOOL_DEFINITIONS,
  McpToolInputError,
  decodePoiResources,
  formatActionEvents,
  formatAirbaseStatus,
  formatKcsapiResponses,
  formatQuests,
  searchEquipment,
  searchShips,
  validateActionEventsArgs,
  validateFleetStatusArgs,
  validateGetAllArgs,
  validateKcsapiResponsesArgs,
  validateNoArguments,
} = require('./lib/mcp-tools')
const {
  collectFleetMetricShips,
  inspectFleetMetrics,
  moraleMeaning,
  speedFromRaw,
  speedMeaning,
} = require('./lib/fleet-metrics')

const PORT_FILE = path.join(os.homedir(), '.poi-mcp', 'port')

// ─── POI HTTP API Client ─────────────────────────────────────────────────────

function getPoiPort() {
  try {
    return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10)
  } catch (_) {
    return null
  }
}

function fetchFromPoi(endpoint) {
  return new Promise((resolve, reject) => {
    const port = getPoiPort()
    if (!port) {
      return reject(new Error(
        'POI data API not found.\n\n' +
        'Please:\n' +
        '  1. Open POI → F12 (DevTools) → Console tab\n' +
        '  2. Paste this script and press Enter:\n\n' +
        '─── PASTE THIS INTO POI CONSOLE ───\n' +
        getInjectScript() +
        '\n─── END ───\n\n' +
        '  3. Then run this MCP server again.'
      ))
    }
    http.get(`http://127.0.0.1:${port}${endpoint}`, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`POI data API returned HTTP ${res.statusCode}`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject).setTimeout(10000, function() {
      this.destroy()
      reject(new Error('Request timed out'))
    })
  })
}

function getInjectScript() {
  return [
    '(function(){',
    'var p=17777;',
    'var s=require("http").createServer(function(q,r){',
    '  r.setHeader("Access-Control-Allow-Origin","*");',
    '  r.setHeader("Content-Type","application/json");',
    '  try{',
    '    var st=window.getStore();',
    '    if(!st||!st.info)throw new Error("Store not ready");',
    '    var u=q.url;',
    '    if(u==="/health"){r.end(JSON.stringify({status:"ok"}))}',
    '    else if(u==="/fleets"){r.end(JSON.stringify(st.info.fleets||[]))}',
    '    else if(u==="/ships"){r.end(JSON.stringify(st.info.ships||{}))}',
    '    else if(u==="/equipment"){r.end(JSON.stringify(st.info.equips||{}))}',
    '    else if(u==="/resources"){r.end(JSON.stringify(st.info.resources||[]))}',
    '    else if(u==="/quests"){r.end(JSON.stringify({activeQuests:st.info.quests?.activeQuests||{},records:st.info.quests?.records||{}}))}',
    '    else if(u==="/airbase"){r.end(JSON.stringify(st.info.airbase||[]))}',
    '    else if(u==="/basic"){r.end(JSON.stringify(st.info.basic||{}))}',
    '    else if(u==="/all"){r.end(JSON.stringify({',
    '      basic:st.info.basic,',
    '      fleets:st.info.fleets,',
    '      ships:st.info.ships,',
    '      equipment:st.info.equips,',
    '      resources:st.info.resources,',
    '      quests:{activeQuests:st.info.quests?.activeQuests,records:st.info.quests?.records},',
    '      airbase:st.info.airbase',
    '    }))}',
    '    else{r.writeHead(404);r.end("Not found")}',
    '  }catch(e){r.writeHead(500);r.end(e.message)}',
    '});',
    's.listen(p,"127.0.0.1",function(){',
    '  var d=require("path").join(require("os").homedir(),".poi-mcp");',
    '  try{require("fs").mkdirSync(d,{recursive:true})}catch(e){}',
    '  require("fs").writeFileSync(require("path").join(d,"port"),String(p),"utf8");',
    '  console.log("[poi-mcp] API: http://127.0.0.1:"+p+"  (/fleets /ships /equipment /resources /quests /airbase /basic /all)");',
    '});',
    '})()'
  ].join('\n')
}

async function fetchMasterData() {
  try {
    return await fetchFromPoi('/master')
  } catch (_) {
    return { ships: {}, equipment: {}, shipTypes: {}, equipmentTypes: {} }
  }
}

function projectFleetShip(ship, shipId, position, equips, names, master) {
  if (!ship) return { id: shipId, position }

  const masterShip = master.ships && master.ships[ship.api_ship_id]
  const shipType = masterShip && master.shipTypes && master.shipTypes[masterShip.api_stype]
  const maxHp = Number(ship.api_maxhp) || 0
  const nameMap = (names && names.ships) || {}
  const equipNames = (names && names.equipment) || {}

  return {
    position,
    id: ship.api_id,
    shipId: ship.api_ship_id,
    masterId: ship.api_ship_id,
    name: nameMap[ship.api_ship_id] || (masterShip && masterShip.api_name) || '',
    typeName: (shipType && shipType.api_name) || '',
    stype: (masterShip && masterShip.api_stype) || null,
    level: ship.api_lv,
    hp: `${ship.api_nowhp}/${ship.api_maxhp}`,
    hpMod4: maxHp % 4,
    morale: ship.api_cond,
    moraleMeaning: moraleMeaning(ship.api_cond || 0),
    speed: Number(ship.api_soku ?? (masterShip && masterShip.api_soku) ?? 0),
    speedMeaning: speedMeaning(speedFromRaw(Number(ship.api_soku ?? (masterShip && masterShip.api_soku) ?? 0))),
    fuel: ship.api_fuel,
    ammo: ship.api_bull,
    locked: ship.api_locked,
    slotnum: ship.api_slotnum || (ship.api_slot || []).filter((id) => id !== -1).length,
    onslot: Array.isArray(ship.api_onslot) ? ship.api_onslot : [],
    sallyArea: ship.api_sally_area || 0,
    fire: ship.api_karyoku || null,
    torp: ship.api_raisou || null,
    aa: ship.api_taiku || null,
    armor: ship.api_soukou || null,
    luck: ship.api_lucky || null,
    los: ship.api_sakuteki || null,
    asw: ship.api_taisen || null,
    slotItems: (ship.api_slot || [])
      .filter((equipId) => equipId > 0)
      .map((equipId) => describeEquip(equipId, equips, { equipment: equipNames }, master))
      .filter(Boolean),
    expansion: describeExpansion(ship.api_slot_ex, equips, { equipment: equipNames }, master),
  }
}

function describeEquip(equipId, equips, names, master) {
  if (!equipId || equipId <= 0) return null
  const equip = equips[equipId]
  if (!equip) return { id: equipId, missing: true }
  const masterId = equip.api_slotitem_id
  const masterEquip = master.equipment && master.equipment[masterId]
  const typeIds = masterEquip && Array.isArray(masterEquip.api_type) ? masterEquip.api_type : []
  const typeId = typeIds[2] || typeIds[1] || typeIds[0]
  const equipType = typeId && master.equipmentTypes && master.equipmentTypes[typeId]
  return {
    id: equip.api_id,
    equipId: masterId,
    name:
      (names.equipment && names.equipment[masterId]) ||
      (masterEquip && masterEquip.api_name) ||
      '',
    typeName: (equipType && equipType.api_name) || '',
    level: equip.api_level || 0,
    prof: equip.api_alv || 0,
  }
}

function describeExpansion(rawEx, equips, names, master) {
  const raw = Number(rawEx)
  if (!Number.isFinite(raw) || raw === 0) {
    return { raw: Number.isFinite(raw) ? raw : 0, state: 'closed', meaning: '未开孔', item: null }
  }
  if (raw < 0) {
    return { raw, state: 'open_empty', meaning: '已开孔但为空', item: null }
  }
  return {
    raw,
    state: 'equipped',
    meaning: '已装备',
    item: describeEquip(raw, equips, names, master),
  }
}

async function fetchAllData(args = {}) {
  const payload = await fetchFromPoi('/all')
  const include = Array.isArray(args.include) ? new Set(args.include) : new Set()

  if (include.has('master')) payload.master = await fetchFromPoi('/master')
  if (include.has('event')) payload.event = await fetchFromPoi('/event')
  if (include.has('planner')) payload.planner = await fetchFromPoi('/planner')

  return payload
}

// ─── MCP Protocol ────────────────────────────────────────────────────────────

// Minimum viable MCP stdio server — no external dependencies

const JSONRPC_VERSION = '2.0'
let reqId = 0

function send(id, result, error) {
  const msg = { jsonrpc: JSONRPC_VERSION, id: id ?? null }
  if (error) msg.error = { code: error.code || -32603, message: error.message }
  else msg.result = result
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendLog(text) {
  console.error('[poi-mcp] ' + text)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  sendLog(`POI MCP Server v${packageJson.version}`)
  sendLog('Checking POI data API...')

  const port = getPoiPort()
  if (!port) {
    sendLog('NOT CONNECTED — POI DevTools script not running')
    sendLog('')
    sendLog('=== 请在 POI 中执行以下步骤 ===')
    sendLog('1. 启动 POI，进入游戏母港')
    sendLog('2. 按 F12 打开 DevTools → Console 标签')
    sendLog('3. 粘贴下面一整段脚本，按回车:')
    sendLog('')
    console.error(getInjectScript())
    sendLog('')
    sendLog('4. 关闭 DevTools，重新运行本命令')
    process.exit(1)
  }

  // Verify the API is responding
  try {
    const health = await fetchFromPoi('/health')
    sendLog(`Connected to POI API on port ${port}: ${health.status}`)
  } catch (err) {
    sendLog(`ERROR: POI API on port ${port} is not responding: ${err.message}`)
    sendLog('Make sure POI is running and the script was pasted into DevTools Console.')
    process.exit(1)
  }

  // ── MCP Request Handler ──────────────────────────────────────────────

  const toolHandlers = {
    get_fleet_status: async (args) => {
      validateFleetStatusArgs(args)
      const fleets = await fetchFromPoi('/fleets')
      if (!Array.isArray(fleets)) return { error: 'No fleet data' }
      const fleet = fleets[args.fleetId - 1]
      if (!fleet) return { error: `Fleet #${args.fleetId} not found` }

      const [ships, equips, names, master, basic] = await Promise.all([
        fetchFromPoi('/ships'),
        fetchFromPoi('/equipment'),
        fetchFromPoi('/names').catch(() => ({ ships: {}, equipment: {} })),
        fetchMasterData(),
        fetchFromPoi('/basic').catch(() => ({})),
      ])
      const hqLevel = Number(basic && basic.api_level)
      const metrics = Number.isInteger(hqLevel) && hqLevel >= 1
        ? inspectFleetMetrics(collectFleetMetricShips(fleet, ships, equips, master), hqLevel)
        : null
      return {
        id: fleet.api_id,
        name: fleet.api_name,
        mission: fleet.api_mission,
        metrics,
        ships: (fleet.api_ship || []).filter(id => id > 0).map((sid, index) =>
          projectFleetShip(ships[sid], sid, index + 1, equips, names, master),
        ),
      }
    },

    search_ships: async (args) => {
      const [ships, fleets, master] = await Promise.all([
        fetchFromPoi('/ships'),
        fetchFromPoi('/fleets'),
        fetchFromPoi('/master'),
      ])
      return searchShips(args, { ships, fleets, master })
    },

    search_equipment: async (args) => {
      const [equipment, ships, master] = await Promise.all([
        fetchFromPoi('/equipment'),
        fetchFromPoi('/ships'),
        fetchFromPoi('/master'),
      ])
      return searchEquipment(args, { equipment, ships, master })
    },

    get_resources: async (args) => {
      validateNoArguments(args)
      return decodePoiResources(await fetchFromPoi('/resources'))
    },

    get_quests: async (args) => {
      validateNoArguments(args)
      return formatQuests(await fetchFromPoi('/quests'))
    },

    get_airbase_status: async (args) => {
      validateNoArguments(args)
      return formatAirbaseStatus(await fetchFromPoi('/airbase'))
    },

    get_all: async (args) => {
      validateGetAllArgs(args)
      return await fetchAllData(args)
    },

    get_battle: async (args) => {
      validateNoArguments(args)
      return await fetchFromPoi('/battle')
    },

    get_action_events: async (args) => {
      const input = validateActionEventsArgs(args)
      const query = new URLSearchParams({
        after: String(input.after),
        limit: String(input.limit + 1),
      })
      return formatActionEvents(
        args,
        await fetchFromPoi(`/action-events?${query.toString()}`),
      )
    },

    get_kcsapi_responses: async (args) => {
      const input = validateKcsapiResponsesArgs(args)
      const query = new URLSearchParams({
        after: String(input.after),
        limit: String(input.limit + 1),
        path: input.apiPath,
      })
      return formatKcsapiResponses(
        args,
        await fetchFromPoi(`/api-responses?${query.toString()}`),
      )
    }
  }

  const resourceUris = [
    'poi://fleets', 'poi://ships', 'poi://equipment',
    'poi://resources', 'poi://quests', 'poi://airbase', 'poi://basic',
    'poi://names', 'poi://master', 'poi://event', 'poi://planner', 'poi://all'
  ]

  // ── JSON-RPC over stdio ──────────────────────────────────────────────

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch (error) {
        send(null, null, { code: -32700, message: error.message })
        continue
      }
      try {
        const { id, method, params } = req

        switch (method) {
          case 'initialize':
            send(id, {
              protocolVersion: '2024-11-05',
              capabilities: {
                resources: { subscribe: false },
                tools: {}
              },
              serverInfo: { name: 'poi-mcp', version: packageJson.version }
            })
            break

          case 'notifications/initialized':
          case 'notifications/cancelled':
            break

          case 'ping':
            send(id, {})
            break

          case 'resources/list':
            send(id, {
              resources: resourceUris.map(uri => ({
                uri, name: uri.replace('poi://', ''), mimeType: 'application/json'
              }))
            })
            break

          case 'resources/read': {
            const uri = params?.uri
            const endpoint = '/' + uri.replace('poi://', '')
            const data = await fetchFromPoi(endpoint)
            send(id, {
              contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(data, null, 2)
              }]
            })
            break
          }

          case 'tools/list':
            send(id, {
              tools: MCP_TOOL_DEFINITIONS
            })
            break

          case 'tools/call': {
            const toolName = params?.name
            const toolArgs = params?.arguments || {}
            const handler = toolHandlers[toolName]
            if (handler) {
              const result = await handler(toolArgs)
              send(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
            } else {
              send(id, null, { code: -32602, message: `Unknown tool: ${toolName}` })
            }
            break
          }

          default:
            send(id, null, { code: -32601, message: `Unknown method: ${method}` })
        }
      } catch (error) {
        send(req && req.id, null, {
          code: error instanceof McpToolInputError ? -32602 : -32603,
          message: error.message,
        })
      }
    }
  })

  process.stdin.on('end', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

main().catch(err => {
  console.error('[poi-mcp] Fatal:', err.message)
  process.exit(1)
})
