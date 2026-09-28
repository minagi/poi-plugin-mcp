const LOS33_FORMULA_ID = 'kcwiki-phase2-33-2026-08'
const FIGHTER_POWER_FORMULA_ID = 'poi-hensei-getTyku-fleet-2026-08'

const LOS_EQUIP_COEFF = Object.freeze({
  9: 0.8,
  10: 1.2,
  11: 1.1,
  12: 0.6,
  13: 0.6,
  94: 1.2,
})

const EXP_TABLE = Object.freeze([0, 10, 25, 40, 55, 70, 85, 100, 121])
const LEVEL_BONUS = Object.freeze({
  6: [0, 0, 2, 5, 9, 14, 14, 22, 22],
  7: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  8: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  11: [0, 1, 1, 1, 1, 3, 3, 6, 6],
  45: [0, 0, 2, 5, 9, 14, 14, 22, 22],
  47: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  48: [0, 0, 2, 5, 9, 14, 14, 22, 22],
  56: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  57: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  58: [0, 0, 0, 0, 0, 0, 0, 0, 0],
})
const CARRIER_TYPES = new Set([6, 7, 8, 45, 47, 56, 57, 58])

function moraleMeaning(cond) {
  if (cond >= 50) return '闪耀'
  if (cond >= 30) return '平常'
  if (cond >= 20) return '疲劳'
  return '过劳'
}

function speedFromRaw(raw) {
  if (raw >= 20) return 'fastest'
  if (raw >= 15) return 'fast_plus'
  if (raw >= 10) return 'fast'
  return 'slow'
}

function speedMeaning(kind) {
  return ({ slow: '低速', fast: '高速', fast_plus: '高速+', fastest: '最速' })[kind]
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function computeLos33(ships, hqLevel, coefficient) {
  let shipSqrtLos = 0
  let equipmentLos = 0
  for (const ship of ships) {
    let equippedLos = 0
    for (const item of ship.slots) {
      equippedLos += item.los
      equipmentLos += item.los * (LOS_EQUIP_COEFF[item.category] ?? 0.6)
    }
    shipSqrtLos += Math.sqrt(Math.max(0, ship.currentLos - equippedLos))
  }
  const hqPenalty = Math.ceil(0.4 * hqLevel)
  const raw = shipSqrtLos + equipmentLos - hqPenalty
  return {
    formulaId: LOS33_FORMULA_ID,
    coefficient,
    raw,
    score: raw * coefficient,
    hqPenalty,
    shipSqrtLos,
    equipmentLos,
  }
}

function slotFighterPower(slot) {
  const count = slot.count
  const category = slot.category
  const tyku = slot.tyku
  const alv = Math.max(0, Math.min(7, Math.trunc(slot.proficiency || 0)))
  if (!(count > 0) || tyku < 0) return null
  const bonus = LEVEL_BONUS[category]
  if (CARRIER_TYPES.has(category)) {
    const levelFactor = slot.bombing > 0 ? 0.25 : 0.2
    const temp = Math.sqrt(count) * (tyku + slot.improvement * levelFactor) + (bonus ? bonus[alv] : 0)
    return {
      basic: Math.floor(Math.sqrt(count) * tyku),
      min: Math.floor(temp + Math.sqrt(EXP_TABLE[alv] / 10)),
      max: Math.floor(temp + Math.sqrt((EXP_TABLE[alv + 1] - 1) / 10)),
    }
  }
  if (category === 11) {
    const temp = Math.sqrt(count) * tyku + (bonus ? bonus[alv] : 0)
    return {
      basic: Math.floor(Math.sqrt(count) * tyku),
      min: Math.floor(temp + Math.sqrt(EXP_TABLE[alv] / 10)),
      max: Math.floor(temp + Math.sqrt((EXP_TABLE[alv + 1] - 1) / 10)),
    }
  }
  return null
}

function computeFleetFighterPower(slots) {
  let basic = 0
  let min = 0
  let max = 0
  for (const slot of slots) {
    const part = slotFighterPower(slot)
    if (!part) continue
    basic += part.basic
    min += part.min
    max += part.max
  }
  return { formulaId: FIGHTER_POWER_FORMULA_ID, basic, min, max }
}

function inspectFleetMetrics(ships, hqLevel) {
  const speedRaws = ships.map((ship) => ship.speedRaw)
  const minSpeedRaw = speedRaws.length === 0 ? 0 : Math.min(...speedRaws)
  const kind = speedFromRaw(minSpeedRaw)
  const morales = ships.map((ship) => ship.morale)
  const minMorale = morales.length === 0 ? 0 : Math.min(...morales)
  const maxMorale = morales.length === 0 ? 0 : Math.max(...morales)
  const catalogComplete = ships.every((ship) =>
    ship.slots.every((slot) => slot.missingCatalog !== true),
  )
  const losRaw = computeLos33(
    ships.map((ship) => ({
      currentLos: ship.currentLos,
      slots: ship.slots.map((slot) => ({ los: slot.los, category: slot.category })),
    })),
    hqLevel,
    1,
  )
  const fp = computeFleetFighterPower(ships.flatMap((ship) => ship.slots))
  return {
    shipCount: ships.length,
    speed: {
      raw: minSpeedRaw,
      kind,
      meaning: speedMeaning(kind),
      allSame: speedRaws.every((raw) => raw === minSpeedRaw),
    },
    morale: {
      min: minMorale,
      max: maxMorale,
      sparkle: morales.filter((value) => value >= 50).length,
      tired: morales.filter((value) => value < 30).length,
      meaning: moraleMeaning(minMorale),
    },
    los33: {
      formulaId: LOS33_FORMULA_ID,
      hqLevel,
      available: catalogComplete,
      hqPenalty: losRaw.hqPenalty,
      raw: losRaw.raw,
      scores: {
        1: round2(losRaw.raw * 1),
        2: round2(losRaw.raw * 2),
        3: round2(losRaw.raw * 3),
        4: round2(losRaw.raw * 4),
      },
    },
    fighterPower: {
      formulaId: FIGHTER_POWER_FORMULA_ID,
      available: catalogComplete,
      basic: fp.basic,
      min: fp.min,
      max: fp.max,
    },
  }
}

function describeEquipFromStore(equipmentId, count, equips, master) {
  if (!equipmentId || equipmentId <= 0) return null
  const equip = equips[equipmentId]
  if (!equip) {
    return {
      category: 0,
      los: 0,
      tyku: 0,
      bombing: 0,
      improvement: 0,
      proficiency: 0,
      count,
      missingCatalog: true,
    }
  }
  const masterId = equip.api_slotitem_id
  const catalog = master.equipment && master.equipment[masterId]
  const types = catalog && Array.isArray(catalog.api_type) ? catalog.api_type : []
  return {
    category: types[2] || 0,
    los: (catalog && catalog.api_saku) || 0,
    tyku: (catalog && catalog.api_tyku) || 0,
    bombing: (catalog && catalog.api_baku) || 0,
    improvement: equip.api_level || 0,
    proficiency: equip.api_alv || 0,
    count,
    missingCatalog: !catalog,
  }
}

function collectFleetMetricShips(fleet, ships, equips, master) {
  return (fleet.api_ship || []).filter((id) => id > 0).map((shipId) => {
    const ship = ships[shipId]
    if (!ship) {
      return {
        instanceId: shipId,
        speedRaw: 0,
        morale: 0,
        currentLos: 0,
        slots: [],
      }
    }
    const masterShip = master.ships && master.ships[ship.api_ship_id]
    const onslot = Array.isArray(ship.api_onslot) ? ship.api_onslot : []
    const slotIds = Array.isArray(ship.api_slot) ? ship.api_slot : []
    const slots = []
    for (let index = 0; index < slotIds.length; index += 1) {
      const described = describeEquipFromStore(slotIds[index], onslot[index] || 0, equips, master)
      if (described) slots.push(described)
    }
    const expansion = Number(ship.api_slot_ex || 0)
    if (expansion > 0) {
      const described = describeEquipFromStore(expansion, 0, equips, master)
      if (described) slots.push(described)
    }
    const sakuteki = Array.isArray(ship.api_sakuteki) ? ship.api_sakuteki : [0]
    return {
      instanceId: ship.api_id,
      speedRaw: Number(ship.api_soku ?? (masterShip && masterShip.api_soku) ?? 0),
      morale: ship.api_cond || 0,
      currentLos: sakuteki[0] || 0,
      fuel: ship.api_fuel || 0,
      ammo: ship.api_bull || 0,
      slots,
    }
  })
}

module.exports = {
  LOS33_FORMULA_ID,
  FIGHTER_POWER_FORMULA_ID,
  moraleMeaning,
  speedFromRaw,
  speedMeaning,
  inspectFleetMetrics,
  collectFleetMetricShips,
  computeFleetFighterPower,
}
