const crypto = require('node:crypto')

const CURSOR_VERSION = 1
const DEFAULT_SEARCH_LIMIT = 100
const MAX_SEARCH_LIMIT = 200
const EQUIPPED_SCOPE = Object.freeze({
  normalShipSlots: true,
  expansionSlots: true,
  airbase: false,
})

const POI_RESOURCE_FIELDS = Object.freeze([
  ['fuel', '燃料'],
  ['ammo', '弾薬'],
  ['steel', '鋼材'],
  ['bauxite', 'ボーキサイト'],
  ['instantConstruction', '高速建造材'],
  ['repairBuckets', '高速修復材'],
  ['developmentMaterials', '開発資材'],
  ['improvementMaterials', '改修資材'],
])

const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'get_fleet_status',
    description:
      'Inspect one owned fleet (1-4): names, slots, expansion, speed, morale, fuel/ammo, Formula 33 LOS (Cn 1-4), and fighter power. Use this instead of get_all when freezing or reading a sortie fleet.',
    inputSchema: {
      type: 'object',
      properties: { fleetId: { type: 'integer', minimum: 1, maximum: 4, description: 'Fleet number, 1-4.' } },
      required: ['fleetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_ships',
    description: 'Search owned ship instances with deterministic keyset pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        masterId: { type: 'integer' },
        masterIds: integerArraySchema(),
        stype: { type: 'integer' },
        stypes: integerArraySchema(),
        minLevel: { type: 'number' },
        maxLevel: { type: 'number' },
        minMorale: { type: 'number' },
        maxMorale: { type: 'number' },
        locked: { type: 'boolean' },
        inFleet: { type: 'boolean' },
        fleetId: { type: 'integer', minimum: 1 },
        sallyArea: { type: 'integer', minimum: 0 },
        hasExpansion: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
        cursor: { type: 'string', minLength: 1, maxLength: 512 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_equipment',
    description:
      'Search or summarize owned equipment. equipped/unequipped covers normal ship slots and expansion slots only; land-base air corps is not included.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        masterId: { type: 'integer' },
        masterIds: integerArraySchema(),
        typeId: { type: 'integer' },
        typeIds: integerArraySchema(),
        minLevel: { type: 'integer', minimum: 0, maximum: 10, description: 'Minimum improvement level.' },
        maxLevel: { type: 'integer', minimum: 0, maximum: 10, description: 'Maximum improvement level.' },
        locked: { type: 'boolean' },
        equipped: { type: 'boolean' },
        limit: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SEARCH_LIMIT,
          description: 'Default 100, or 0 when summary is true and limit is omitted. Zero requires summary:true.',
        },
        cursor: { type: 'string', minLength: 1, maxLength: 512 },
        summary: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_resources',
    description:
      '現在の資源を名前付きフィールドで取得します。Poi配列の順序は、燃料、弾薬、鋼材、ボーキサイト、高速建造材、高速修復材、開発資材、改修資材です。HTTP /resources は従来どおり8要素のraw配列を返します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_quests',
    description:
      'Get accepted quests and quest progress records held by the Poi store. This is not the complete list of all currently available quests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_airbase_status',
    description:
      'Get the current raw land-base air corps data held by the Poi store. No master-data name enrichment is applied.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_all',
    description:
      'Last-resort full account dump (all ships, equipment, quests, maps). Prefer get_fleet_status, search_*, or get_resources. Do not use this to name one fleet.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: ['master', 'event', 'planner'] },
        },
      },
      additionalProperties: false,
    },
  },
])

class McpToolInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'McpToolInputError'
    this.code = -32602
  }
}

function decodePoiResources(raw) {
  const values = Array.isArray(raw) ? raw : []
  const named = { raw: values }
  for (let index = 0; index < POI_RESOURCE_FIELDS.length; index += 1) {
    const [key, label] = POI_RESOURCE_FIELDS[index]
    named[key] = { key, label, raw: values[index] ?? null }
  }
  return named
}

function normalizeSearchText(value) {
  return String(value).trim().normalize('NFC').toLowerCase()
}

function formatQuests(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    activeQuests: source.activeQuests || {},
    records: source.records || {},
  }
}

function formatAirbaseStatus(raw) {
  return {
    source: 'poi.store.info.airbase',
    enriched: false,
    airbase: Array.isArray(raw) ? raw : [],
  }
}

function equipmentTypeId(masterEquipment) {
  const typeIds = masterEquipment && Array.isArray(masterEquipment.api_type)
    ? masterEquipment.api_type
    : []
  return typeIds[2] ?? typeIds[1] ?? typeIds[0] ?? null
}

function searchShips(args = {}, snapshot = {}) {
  const master = snapshot.master || {}
  const inventory = Object.values(snapshot.ships || {}).filter(Boolean)
  const filters = validateShipSearchArgs(args)
  const fleetIndex = buildShipFleetIndex(snapshot.fleets)
  const matched = inventory.filter((ship) => {
    const masterShip = master.ships && master.ships[ship.api_ship_id]
    const fleetIds = fleetIndex.get(Number(ship.api_id)) || []
    const masterId = Number(ship.api_ship_id)
    const stype = masterShip == null ? null : Number(masterShip.api_stype)
    const name = normalizeSearchText((masterShip && masterShip.api_name) || '')
    if (filters.name != null && !name.includes(filters.name)) return false
    if (filters.masterIds != null && !filters.masterIds.includes(masterId)) return false
    if (filters.stypes != null && !filters.stypes.includes(stype)) return false
    if (filters.minLevel != null && Number(ship.api_lv) < filters.minLevel) return false
    if (filters.maxLevel != null && Number(ship.api_lv) > filters.maxLevel) return false
    if (filters.minMorale != null && Number(ship.api_cond) < filters.minMorale) return false
    if (filters.maxMorale != null && Number(ship.api_cond) > filters.maxMorale) return false
    if (filters.locked != null && Boolean(ship.api_locked) !== filters.locked) return false
    if (filters.inFleet != null && (fleetIds.length > 0) !== filters.inFleet) return false
    if (filters.fleetId != null && !fleetIds.includes(filters.fleetId)) return false
    if (filters.sallyArea != null && Number(ship.api_sally_area || 0) !== filters.sallyArea) return false
    if (filters.hasExpansion != null && hasExpansionSlot(ship) !== filters.hasExpansion) return false
    return true
  }).map((ship) => enrichShip(ship, master, fleetIndex.get(Number(ship.api_id)) || []))
  const page = paginateByInstanceId('search_ships', matched, args, filters)
  return {
    inventoryTotal: inventory.length,
    total: matched.length,
    returned: page.items.length,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    ships: page.items,
  }
}

function searchEquipment(args = {}, snapshot = {}) {
  const master = snapshot.master || {}
  const inventory = Object.values(snapshot.equipment || {}).filter(Boolean)
  const validated = validateEquipmentSearchArgs(args)
  const filters = validated.filters
  const usageIndex = buildEquipmentUsageIndex(snapshot.ships)
  const matched = inventory.filter((item) => {
    const masterEquipment = master.equipment && master.equipment[item.api_slotitem_id]
    const masterId = Number(item.api_slotitem_id)
    const typeId = equipmentTypeId(masterEquipment)
    const level = Number(item.api_level || 0)
    const equipped = usageIndex.has(Number(item.api_id))
    const name = normalizeSearchText((masterEquipment && masterEquipment.api_name) || '')
    if (filters.name != null && !name.includes(filters.name)) return false
    if (filters.masterIds != null && !filters.masterIds.includes(masterId)) return false
    if (filters.typeIds != null && !filters.typeIds.includes(typeId)) return false
    if (filters.minLevel != null && level < filters.minLevel) return false
    if (filters.maxLevel != null && level > filters.maxLevel) return false
    if (filters.locked != null && Boolean(item.api_locked) !== filters.locked) return false
    if (filters.equipped != null && equipped !== filters.equipped) return false
    return true
  }).map((item) => enrichEquipment(item, master, usageIndex.get(Number(item.api_id)) || []))
  const page = paginateByInstanceId('search_equipment', matched, args, filters, {
    limit: validated.limit,
  })
  return {
    inventoryTotal: inventory.length,
    total: matched.length,
    returned: page.items.length,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    equipment: page.items,
    equippedScope: { ...EQUIPPED_SCOPE },
    summary: validated.summary ? summarizeEquipment(matched) : null,
  }
}

function paginateByInstanceId(toolName, items, args, filters, options = {}) {
  const limit = options.limit ?? normalizeLimit(args.limit, options.defaultLimit)
  const filterHash = hashFilters(filters)
  const afterId = args.cursor == null
    ? null
    : decodeCursor(args.cursor, toolName, filterHash)
  const sorted = [...items].sort((left, right) => instanceId(left) - instanceId(right))
  const remaining = afterId == null
    ? sorted
    : sorted.filter((item) => instanceId(item) > afterId)
  if (limit === 0) return { items: [], hasMore: false, nextCursor: null }
  const pageItems = remaining.slice(0, limit)
  const hasMore = remaining.length > pageItems.length
  const nextCursor = hasMore && pageItems.length > 0
    ? encodeCursor(toolName, filterHash, instanceId(pageItems[pageItems.length - 1]))
    : null
  return { items: pageItems, hasMore, nextCursor }
}

function normalizeLimit(value, fallback = DEFAULT_SEARCH_LIMIT) {
  if (value == null) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEARCH_LIMIT) {
    throw new McpToolInputError(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`)
  }
  return value
}

function encodeCursor(toolName, filterHash, lastInstanceId) {
  return Buffer.from(JSON.stringify({
    version: CURSOR_VERSION,
    toolName,
    lastInstanceId,
    normalizedFilterHash: filterHash,
  }), 'utf8').toString('base64url')
}

function decodeCursor(cursor, toolName, expectedFilterHash) {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new McpToolInputError('cursor must be a valid opaque cursor')
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (_) {
    throw new McpToolInputError('cursor must be a valid opaque cursor')
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(',') !==
      'lastInstanceId,normalizedFilterHash,toolName,version'
  ) {
    throw new McpToolInputError('cursor has an invalid structure')
  }
  if (payload.version !== CURSOR_VERSION) {
    throw new McpToolInputError('cursor version is not supported')
  }
  if (payload.toolName !== toolName) {
    throw new McpToolInputError('cursor belongs to a different tool')
  }
  if (
    !Number.isSafeInteger(payload.lastInstanceId) ||
    payload.lastInstanceId <= 0
  ) {
    throw new McpToolInputError('cursor lastInstanceId is invalid')
  }
  if (
    typeof payload.normalizedFilterHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.normalizedFilterHash) ||
    payload.normalizedFilterHash !== expectedFilterHash
  ) {
    throw new McpToolInputError('cursor filters do not match this search')
  }
  return payload.lastInstanceId
}

function hashFilters(filters) {
  const normalized = Object.fromEntries(
    Object.entries(filters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value == null ? null : value]),
  )
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function optionalFiniteNumber(value, name) {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new McpToolInputError(`${name} must be a finite number`)
  }
  return value
}

function hasExpansionSlot(ship) {
  const raw = Number(ship && ship.api_slot_ex)
  return Number.isFinite(raw) && raw !== 0
}

function integerArraySchema() {
  return {
    type: 'array',
    items: { type: 'integer' },
    uniqueItems: true,
  }
}

function assertPlainObject(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpToolInputError(`${name} must be an object`)
  }
}

function rejectUnknownProperties(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new McpToolInputError(`Unknown input property: ${unknown[0]}`)
  }
}

function validateNoArguments(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set())
}

function validateFleetStatusArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set(['fleetId']))
  const fleetId = optionalInteger(args.fleetId, 'fleetId', 1)
  if (fleetId == null || fleetId > 4) {
    throw new McpToolInputError('fleetId must be an integer from 1 to 4')
  }
}

function validateGetAllArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set(['include']))
  if (args.include == null) return
  if (!Array.isArray(args.include)) {
    throw new McpToolInputError('include must be an array')
  }
  const allowed = new Set(['master', 'event', 'planner'])
  for (const value of args.include) {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new McpToolInputError('include contains an unsupported value')
    }
  }
}

function optionalInteger(value, name, minimum = null) {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || (minimum != null && value < minimum)) {
    const suffix = minimum == null ? '' : ` greater than or equal to ${minimum}`
    throw new McpToolInputError(`${name} must be an integer${suffix}`)
  }
  return value
}

function optionalBoolean(value, name) {
  if (value == null) return null
  if (typeof value !== 'boolean') {
    throw new McpToolInputError(`${name} must be a boolean`)
  }
  return value
}

function optionalSearchName(value) {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new McpToolInputError('name must be a string')
  }
  return normalizeSearchText(value)
}

function combinedIntegerSelectors(singular, plural, singularName, pluralName) {
  const values = []
  const single = optionalInteger(singular, singularName, 1)
  if (single != null) values.push(single)
  if (plural != null) {
    if (!Array.isArray(plural)) {
      throw new McpToolInputError(`${pluralName} must be an array of integers`)
    }
    for (const value of plural) {
      values.push(optionalInteger(value, pluralName, 1))
    }
  }
  return values.length === 0 ? null : [...new Set(values)].sort((left, right) => left - right)
}

function assertMinimumAtMostMaximum(minimum, maximum, minimumName, maximumName) {
  if (minimum != null && maximum != null && minimum > maximum) {
    throw new McpToolInputError(`${minimumName} must be less than or equal to ${maximumName}`)
  }
}

function validateShipSearchArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set([
    'name', 'masterId', 'masterIds', 'stype', 'stypes',
    'minLevel', 'maxLevel', 'minMorale', 'maxMorale',
    'locked', 'inFleet', 'fleetId', 'sallyArea', 'hasExpansion',
    'limit', 'cursor',
  ]))
  const minLevel = optionalFiniteNumber(args.minLevel, 'minLevel')
  const maxLevel = optionalFiniteNumber(args.maxLevel, 'maxLevel')
  const minMorale = optionalFiniteNumber(args.minMorale, 'minMorale')
  const maxMorale = optionalFiniteNumber(args.maxMorale, 'maxMorale')
  assertMinimumAtMostMaximum(minLevel, maxLevel, 'minLevel', 'maxLevel')
  assertMinimumAtMostMaximum(minMorale, maxMorale, 'minMorale', 'maxMorale')
  const inFleet = optionalBoolean(args.inFleet, 'inFleet')
  const fleetId = optionalInteger(args.fleetId, 'fleetId', 1)
  if (fleetId != null && inFleet === false) {
    throw new McpToolInputError('fleetId cannot be combined with inFleet:false')
  }
  normalizeLimit(args.limit)
  if (args.cursor != null && typeof args.cursor !== 'string') {
    throw new McpToolInputError('cursor must be a string')
  }
  return {
    name: optionalSearchName(args.name),
    masterIds: combinedIntegerSelectors(args.masterId, args.masterIds, 'masterId', 'masterIds'),
    stypes: combinedIntegerSelectors(args.stype, args.stypes, 'stype', 'stypes'),
    minLevel,
    maxLevel,
    minMorale,
    maxMorale,
    locked: optionalBoolean(args.locked, 'locked'),
    inFleet: fleetId == null ? inFleet : true,
    fleetId,
    sallyArea: optionalInteger(args.sallyArea, 'sallyArea', 0),
    hasExpansion: optionalBoolean(args.hasExpansion, 'hasExpansion'),
  }
}

function buildShipFleetIndex(fleets) {
  const index = new Map()
  const list = Array.isArray(fleets) ? fleets : []
  list.forEach((fleet, position) => {
    if (!fleet || !Array.isArray(fleet.api_ship)) return
    const rawFleetId = Number(fleet.api_id)
    const fleetId = Number.isSafeInteger(rawFleetId) && rawFleetId > 0
      ? rawFleetId
      : position + 1
    for (const rawShipId of fleet.api_ship) {
      const shipId = Number(rawShipId)
      if (!Number.isSafeInteger(shipId) || shipId <= 0) continue
      const fleetIds = index.get(shipId) || []
      if (!fleetIds.includes(fleetId)) fleetIds.push(fleetId)
      index.set(shipId, fleetIds)
    }
  })
  return index
}

function validateEquipmentSearchArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set([
    'name', 'masterId', 'masterIds', 'typeId', 'typeIds',
    'minLevel', 'maxLevel', 'locked', 'equipped',
    'limit', 'cursor', 'summary',
  ]))
  const minLevel = optionalInteger(args.minLevel, 'minLevel', 0)
  const maxLevel = optionalInteger(args.maxLevel, 'maxLevel', 0)
  if (minLevel != null && minLevel > 10) {
    throw new McpToolInputError('minLevel must be an integer from 0 to 10')
  }
  if (maxLevel != null && maxLevel > 10) {
    throw new McpToolInputError('maxLevel must be an integer from 0 to 10')
  }
  assertMinimumAtMostMaximum(minLevel, maxLevel, 'minLevel', 'maxLevel')
  const summary = optionalBoolean(args.summary, 'summary') || false
  let limit
  if (args.limit == null) {
    limit = summary ? 0 : DEFAULT_SEARCH_LIMIT
  } else {
    limit = optionalInteger(args.limit, 'limit', 0)
    if (limit > MAX_SEARCH_LIMIT) {
      throw new McpToolInputError(`limit must be an integer from 0 to ${MAX_SEARCH_LIMIT}`)
    }
  }
  if (!summary && limit === 0) {
    throw new McpToolInputError('limit:0 requires summary:true')
  }
  if (args.cursor != null && typeof args.cursor !== 'string') {
    throw new McpToolInputError('cursor must be a string')
  }
  return {
    summary,
    limit,
    filters: {
      name: optionalSearchName(args.name),
      masterIds: combinedIntegerSelectors(args.masterId, args.masterIds, 'masterId', 'masterIds'),
      typeIds: combinedIntegerSelectors(args.typeId, args.typeIds, 'typeId', 'typeIds'),
      minLevel,
      maxLevel,
      locked: optionalBoolean(args.locked, 'locked'),
      equipped: optionalBoolean(args.equipped, 'equipped'),
    },
  }
}

function buildEquipmentUsageIndex(ships) {
  const index = new Map()
  for (const ship of Object.values(ships || {})) {
    if (!ship) continue
    const shipInstanceId = Number(ship.api_id)
    const slots = Array.isArray(ship.api_slot) ? ship.api_slot : []
    slots.forEach((rawEquipmentId, slotIndex) => {
      addEquipmentUsage(index, rawEquipmentId, {
        shipInstanceId,
        slotType: 'normal',
        slotIndex,
      })
    })
    addEquipmentUsage(index, ship.api_slot_ex, {
      shipInstanceId,
      slotType: 'expansion',
    })
  }
  return index
}

function addEquipmentUsage(index, rawEquipmentId, location) {
  const equipmentId = Number(rawEquipmentId)
  if (!Number.isSafeInteger(equipmentId) || equipmentId <= 0) return
  const locations = index.get(equipmentId) || []
  locations.push(location)
  index.set(equipmentId, locations)
}

function summarizeEquipment(items) {
  const byImprovement = countByImprovement(items)
  const groups = new Map()
  for (const item of items) {
    const masterId = Number(item.masterId)
    let group = groups.get(masterId)
    if (!group) {
      group = {
        masterId,
        name: item.name,
        typeId: item.typeId,
        typeName: item.typeName,
        items: [],
      }
      groups.set(masterId, group)
    }
    group.items.push(item)
  }
  const byMasterId = [...groups.values()]
    .sort((left, right) => left.masterId - right.masterId)
    .map((group) => ({
      masterId: group.masterId,
      name: group.name,
      typeId: group.typeId,
      typeName: group.typeName,
      ...equipmentCounts(group.items),
      byImprovement: countByImprovement(group.items),
    }))
  return {
    ...equipmentCounts(items),
    byImprovement,
    byMasterId,
  }
}

function equipmentCounts(items) {
  const lockedCount = items.filter((item) => Boolean(item.api_locked)).length
  const equippedCount = items.filter((item) => item.equipped).length
  return {
    total: items.length,
    lockedCount,
    unlockedCount: items.length - lockedCount,
    equippedCount,
    unequippedCount: items.length - equippedCount,
  }
}

function countByImprovement(items) {
  const counts = new Map()
  for (const item of items) {
    const level = Number(item.api_level || 0)
    counts.set(level, (counts.get(level) || 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, count]) => ({ level, count }))
}

function instanceId(item) {
  const value = Number(item && item.instanceId)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Owned instance is missing a positive integer api_id')
  }
  return value
}

function enrichShip(ship, master, fleetIds = []) {
  const masterShip = master.ships && master.ships[ship.api_ship_id]
  const shipType = masterShip && master.shipTypes && master.shipTypes[masterShip.api_stype]
  return {
    ...ship,
    instanceId: ship.api_id,
    masterId: ship.api_ship_id,
    name: (masterShip && masterShip.api_name) || '',
    stype: (masterShip && masterShip.api_stype) ?? null,
    typeName: (shipType && shipType.api_name) || '',
    inFleet: fleetIds.length > 0,
    fleetIds: [...fleetIds],
    hasExpansion: hasExpansionSlot(ship),
  }
}

function enrichEquipment(item, master, equippedOn = []) {
  const masterEquipment = master.equipment && master.equipment[item.api_slotitem_id]
  const typeId = equipmentTypeId(masterEquipment)
  const equipmentType = typeId != null && master.equipmentTypes
    ? master.equipmentTypes[typeId]
    : null
  return {
    ...item,
    instanceId: item.api_id,
    masterId: item.api_slotitem_id,
    name: (masterEquipment && masterEquipment.api_name) || '',
    typeId,
    typeName: (equipmentType && equipmentType.api_name) || '',
    equipped: equippedOn.length > 0,
    equippedOn: equippedOn.map((location) => ({ ...location })),
  }
}

module.exports = {
  MCP_TOOL_DEFINITIONS,
  McpToolInputError,
  decodeCursor,
  decodePoiResources,
  encodeCursor,
  equipmentTypeId,
  formatAirbaseStatus,
  formatQuests,
  normalizeSearchText,
  searchEquipment,
  searchShips,
  validateEquipmentSearchArgs,
  validateFleetStatusArgs,
  validateGetAllArgs,
  validateNoArguments,
  validateShipSearchArgs,
}
