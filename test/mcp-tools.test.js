const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  decodePoiResources,
  formatAirbaseStatus,
  formatQuests,
  searchEquipment,
  searchShips,
} = require('../lib/mcp-tools')
const { createStoreFixture } = require('./fixtures')

test('decodePoiResources preserves all eight raw values and field positions', () => {
  const raw = [0, 2, 3, 4, 5, 6, 7, 8]
  const result = decodePoiResources(raw)

  assert.deepEqual(result.raw, raw)
  assert.equal(result.fuel.raw, 0)
  assert.equal(result.ammo.raw, 2)
  assert.equal(result.steel.raw, 3)
  assert.equal(result.bauxite.raw, 4)
  assert.equal(result.instantConstruction.raw, 5)
  assert.equal(result.repairBuckets.raw, 6)
  assert.equal(result.developmentMaterials.raw, 7)
  assert.equal(result.improvementMaterials.raw, 8)
  assert.deepEqual(
    [
      result.fuel.label,
      result.ammo.label,
      result.steel.label,
      result.bauxite.label,
      result.instantConstruction.label,
      result.repairBuckets.label,
      result.developmentMaterials.label,
      result.improvementMaterials.label,
    ],
    ['燃料', '弾薬', '鋼材', 'ボーキサイト', '高速建造材', '高速修復材', '開発資材', '改修資材'],
  )
})

test('decodePoiResources uses null for missing positions without changing raw', () => {
  const raw = [11, 12]
  const result = decodePoiResources(raw)

  assert.deepEqual(result.raw, raw)
  assert.equal(result.fuel.raw, 11)
  assert.equal(result.ammo.raw, 12)
  assert.equal(result.steel.raw, null)
  assert.equal(result.improvementMaterials.raw, null)
})

test('shared searches preserve legacy filters and tolerate missing master data', () => {
  const store = createStoreFixture()
  const ships = searchShips({ minLevel: 50, maxLevel: 100, minMorale: 40 }, {
    ships: store.info.ships,
    master: {},
  })
  assert.equal(ships.total, 1)
  assert.equal(ships.ships[0].instanceId, 101)
  assert.equal(ships.ships[0].name, '')
  assert.equal(ships.ships[0].typeName, '')

  const equipment = searchEquipment({ minLevel: 1 }, {
    equipment: store.info.equips,
    master: {},
  })
  assert.equal(equipment.total, 1)
  assert.equal(equipment.equipment[0].instanceId, 201)
  assert.equal(equipment.equipment[0].name, '')
  assert.equal(equipment.equipment[0].typeName, '')
})

test('ship and equipment searches use deterministic keyset cursors', () => {
  const store = createStoreFixture()
  const master = {
    ships: store.const.$ships,
    shipTypes: store.const.$shipTypes,
    equipment: store.const.$equips,
    equipmentTypes: store.const.$equipTypes,
  }
  const firstShips = searchShips({ limit: 1 }, { ships: store.info.ships, master })
  assert.equal(firstShips.inventoryTotal, 2)
  assert.equal(firstShips.total, 2)
  assert.equal(firstShips.returned, 1)
  assert.equal(firstShips.hasMore, true)
  assert.equal(firstShips.ships[0].instanceId, 101)
  const secondShips = searchShips(
    { limit: 1, cursor: firstShips.nextCursor },
    { ships: store.info.ships, master },
  )
  assert.equal(secondShips.ships[0].instanceId, 102)
  assert.equal(secondShips.hasMore, false)
  assert.equal(secondShips.nextCursor, null)

  const firstEquipment = searchEquipment(
    { minLevel: 0, limit: 1 },
    { equipment: store.info.equips, master },
  )
  assert.equal(firstEquipment.equipment[0].instanceId, 201)
  const continuedWithDifferentLimit = searchEquipment(
    { minLevel: 0, limit: 2, summary: true, cursor: firstEquipment.nextCursor },
    { equipment: store.info.equips, master },
  )
  assert.equal(continuedWithDifferentLimit.equipment[0].instanceId, 202)
  assert.throws(
    () => searchEquipment(
      { minLevel: 1, limit: 1, cursor: firstEquipment.nextCursor },
      { equipment: store.info.equips, master },
    ),
    /cursor filters do not match/u,
  )
  assert.throws(
    () => searchEquipment(
      { limit: 1, cursor: firstShips.nextCursor },
      { equipment: store.info.equips, master },
    ),
    /different tool/u,
  )
  assert.throws(
    () => searchShips({ cursor: 'not+base64' }, { ships: store.info.ships, master }),
    /valid opaque cursor/u,
  )

  const decoded = JSON.parse(Buffer.from(firstShips.nextCursor, 'base64url').toString('utf8'))
  const unsupportedVersion = Buffer.from(JSON.stringify({ ...decoded, version: 99 })).toString('base64url')
  assert.throws(
    () => searchShips({ limit: 1, cursor: unsupportedVersion }, { ships: store.info.ships, master }),
    /version is not supported/u,
  )
  const invalidLastId = Buffer.from(JSON.stringify({ ...decoded, lastInstanceId: '101' })).toString('base64url')
  assert.throws(
    () => searchShips({ limit: 1, cursor: invalidLastId }, { ships: store.info.ships, master }),
    /lastInstanceId is invalid/u,
  )
  const missingField = { ...decoded }
  delete missingField.lastInstanceId
  assert.throws(
    () => searchShips({ limit: 1, cursor: Buffer.from(JSON.stringify(missingField)).toString('base64url') }, {
      ships: store.info.ships,
      master,
    }),
    /invalid structure/u,
  )
})

test('quest and airbase formatters preserve their resource data without enrichment', () => {
  const store = createStoreFixture()
  assert.deepEqual(formatQuests(store.info.quests), store.info.quests)

  const result = formatAirbaseStatus(store.info.airbase)
  assert.equal(result.source, 'poi.store.info.airbase')
  assert.equal(result.enriched, false)
  assert.deepEqual(result.airbase, store.info.airbase)
  assert.equal(result.airbase[0].unknownFixtureField, 'kept')
})

test('searchShips supports inventory filters, derived fleet fields, and validation', () => {
  const store = createStoreFixture()
  const snapshot = {
    ships: store.info.ships,
    fleets: store.info.fleets,
    master: {
      ships: store.const.$ships,
      shipTypes: store.const.$shipTypes,
    },
  }

  const first = searchShips({
    name: '  fixture DESTROYER  ',
    masterIds: [999, 501],
    stype: 2,
    minLevel: 80,
    maxLevel: 80,
    minMorale: 49,
    maxMorale: 49,
    locked: true,
    inFleet: true,
    fleetId: 1,
    sallyArea: 2,
    hasExpansion: true,
  }, snapshot)
  assert.equal(first.total, 1)
  assert.deepEqual(first.ships[0].fleetIds, [1])
  assert.equal(first.ships[0].inFleet, true)
  assert.equal(first.ships[0].hasExpansion, true)
  assert.equal(first.ships[0].stype, 2)

  delete store.info.ships[102].api_slot_ex
  const second = searchShips({
    masterId: 999,
    masterIds: [502],
    stype: 99,
    stypes: [2],
    locked: false,
    inFleet: false,
    sallyArea: 0,
    hasExpansion: false,
  }, snapshot)
  assert.equal(second.total, 1)
  assert.equal(second.ships[0].instanceId, 102)
  assert.deepEqual(second.ships[0].fleetIds, [])

  assert.throws(() => searchShips({ minLevel: 2, maxLevel: 1 }, snapshot), /less than or equal/u)
  assert.throws(() => searchShips({ minMorale: 2, maxMorale: 1 }, snapshot), /less than or equal/u)
  assert.throws(() => searchShips({ fleetId: 1, inFleet: false }, snapshot), /cannot be combined/u)
  assert.throws(() => searchShips({ unexpected: true }, snapshot), /Unknown input property/u)
  assert.throws(() => searchShips({ limit: 201 }, snapshot), /limit must be/u)
  assert.throws(() => searchShips({ minLevel: '20' }, snapshot), /finite number/u)
})

test('searchEquipment filters and reports normal and expansion-slot usage', () => {
  const store = createStoreFixture()
  const snapshot = {
    equipment: store.info.equips,
    ships: store.info.ships,
    master: {
      equipment: store.const.$equips,
      equipmentTypes: store.const.$equipTypes,
    },
  }

  const normal = searchEquipment({
    name: ' fixture GUN ',
    masterId: 999,
    masterIds: [301],
    typeId: 999,
    typeIds: [1],
    minLevel: 6,
    maxLevel: 6,
    locked: true,
    equipped: true,
  }, snapshot)
  assert.equal(normal.total, 1)
  assert.equal(normal.equipment[0].instanceId, 201)
  assert.equal(normal.equipment[0].typeId, 1)
  assert.deepEqual(normal.equipment[0].equippedOn, [
    { shipInstanceId: 101, slotType: 'normal', slotIndex: 0 },
  ])

  const expansion = searchEquipment({ masterId: 302, equipped: true }, snapshot)
  assert.equal(expansion.total, 1)
  assert.deepEqual(expansion.equipment[0].equippedOn, [
    { shipInstanceId: 101, slotType: 'expansion' },
  ])
  assert.deepEqual(expansion.equippedScope, {
    normalShipSlots: true,
    expansionSlots: true,
    airbase: false,
  })

  const unused = searchEquipment({ equipped: false }, snapshot)
  assert.equal(unused.total, 1)
  assert.equal(unused.equipment[0].instanceId, 203)

  store.info.ships[102].api_slot = [201, -1, -1, -1, -1]
  const duplicated = searchEquipment({ masterId: 301, equipped: true }, snapshot)
  assert.equal(duplicated.equipment[0].equippedOn.length, 2)

  assert.throws(() => searchEquipment({ minLevel: 8, maxLevel: 7 }, snapshot), /less than or equal/u)
  assert.throws(() => searchEquipment({ minLevel: 11 }, snapshot), /from 0 to 10/u)
  assert.throws(() => searchEquipment({ locked: 1 }, snapshot), /must be a boolean/u)
  assert.throws(() => searchEquipment({ limit: 0 }, snapshot), /requires summary:true/u)
  assert.throws(() => searchEquipment({ limit: '1' }, snapshot), /must be an integer/u)
  assert.throws(() => searchEquipment({ unexpected: true }, snapshot), /Unknown input property/u)
})

test('searchEquipment summary is computed before pagination and omits instances by default', () => {
  const store = createStoreFixture()
  const snapshot = {
    equipment: store.info.equips,
    ships: store.info.ships,
    master: {
      equipment: store.const.$equips,
      equipmentTypes: store.const.$equipTypes,
    },
  }
  const result = searchEquipment({ summary: true }, snapshot)
  assert.equal(result.total, 3)
  assert.equal(result.returned, 0)
  assert.deepEqual(result.equipment, [])
  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, null)
  assert.deepEqual(result.summary, {
    total: 3,
    lockedCount: 1,
    unlockedCount: 2,
    equippedCount: 2,
    unequippedCount: 1,
    byImprovement: [
      { level: 0, count: 2 },
      { level: 6, count: 1 },
    ],
    byMasterId: [
      {
        masterId: 301,
        name: 'Fixture Gun',
        typeId: 1,
        typeName: 'Small Gun',
        total: 2,
        lockedCount: 1,
        unlockedCount: 1,
        equippedCount: 1,
        unequippedCount: 1,
        byImprovement: [
          { level: 0, count: 1 },
          { level: 6, count: 1 },
        ],
      },
      {
        masterId: 302,
        name: 'Fixture Fighter',
        typeId: 6,
        typeName: 'Fighter',
        total: 1,
        lockedCount: 0,
        unlockedCount: 1,
        equippedCount: 1,
        unequippedCount: 0,
        byImprovement: [{ level: 0, count: 1 }],
      },
    ],
  })

  const withPage = searchEquipment({ summary: true, limit: 1 }, snapshot)
  assert.equal(withPage.returned, 1)
  assert.equal(withPage.hasMore, true)
  assert.ok(withPage.nextCursor)
  assert.equal(withPage.summary.total, 3)
})

test('searchEquipment handles a deterministic 3,500-item inventory without oversized pages', () => {
  const equipment = {}
  const masterEquipment = {}
  for (let masterId = 1; masterId <= 50; masterId += 1) {
    masterEquipment[masterId] = {
      api_id: masterId,
      api_name: `Generated Equipment ${masterId}`,
      api_type: [1, 1, (masterId % 5) + 1],
    }
  }
  for (let index = 0; index < 3500; index += 1) {
    const instanceId = 10000 + index
    equipment[instanceId] = {
      api_id: instanceId,
      api_slotitem_id: (index % 50) + 1,
      api_level: index % 11,
      api_locked: index % 2,
    }
  }
  const snapshot = {
    equipment,
    ships: {},
    master: { equipment: masterEquipment, equipmentTypes: {} },
  }

  const started = process.hrtime.bigint()
  const summary = searchEquipment({ summary: true }, snapshot)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(summary.total, 3500)
  assert.equal(summary.returned, 0)
  assert.equal(summary.summary.byMasterId.length, 50)
  assert.ok(elapsedMs < 2000, `3,500-item summary took ${elapsedMs.toFixed(1)}ms`)

  const firstPage = searchEquipment({ limit: 200 }, snapshot)
  assert.equal(firstPage.returned, 200)
  assert.equal(firstPage.hasMore, true)
  assert.equal(firstPage.equipment[0].instanceId, 10000)
  assert.equal(firstPage.equipment[199].instanceId, 10199)
  assert.equal(searchEquipment({}, snapshot).returned, 100)
  const secondPage = searchEquipment({ limit: 200, cursor: firstPage.nextCursor }, snapshot)
  assert.equal(secondPage.equipment[0].instanceId, 10200)
  assert.equal(new Set([
    ...firstPage.equipment.map((item) => item.instanceId),
    ...secondPage.equipment.map((item) => item.instanceId),
  ]).size, 400)

  const none = searchEquipment({ masterId: 99999 }, snapshot)
  assert.equal(none.total, 0)
  assert.deepEqual(none.equipment, [])
  assert.equal(none.nextCursor, null)
})

test('name matching applies trim, NFC normalization, and case folding', () => {
  const store = createStoreFixture()
  store.const.$ships[501].api_name = 'Cafe\u0301 Destroyer'
  store.const.$equips[301].api_name = 'Cafe\u0301 Gun'
  const master = {
    ships: store.const.$ships,
    shipTypes: store.const.$shipTypes,
    equipment: store.const.$equips,
    equipmentTypes: store.const.$equipTypes,
  }
  assert.equal(searchShips({ name: ' CAFÉ ' }, {
    ships: store.info.ships,
    fleets: store.info.fleets,
    master,
  }).total, 1)
  assert.equal(searchEquipment({ name: ' CAFÉ ' }, {
    equipment: store.info.equips,
    ships: store.info.ships,
    master,
  }).total, 2)
})
