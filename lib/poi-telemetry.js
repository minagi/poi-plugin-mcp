const crypto = require('node:crypto')
const { createPoiActionEvents } = require('./poi-action-events')
const { createPoiApiResponses } = require('./poi-api-responses')

const QUEST_LIST_PATH = '/kcsapi/api_get_member/questlist'
const QUEST_SNAPSHOT_TTL_MS = 5 * 60 * 1000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const QUEST_RECONNECT_PATHS = new Set([
  '/kcsapi/api_start2/getData',
  '/kcsapi/api_get_member/require_info',
])
const MISSION_BOARD_PATH = '/kcsapi/api_get_member/mission'
const UNSET_SLOT_PATH = '/kcsapi/api_get_member/unsetslot'
const EQUIPMENT_SELECTION_PATH = '/kcsapi/api_req_kaisou/slot_select'
const QUEST_ACTION_PATHS = new Set([
  '/kcsapi/api_req_quest/start',
  '/kcsapi/api_req_quest/stop',
  '/kcsapi/api_req_quest/clearitemget',
])
const EQUIPMENT_ACTION_PATHS = new Set([
  '/kcsapi/api_req_kaisou/slotset',
  '/kcsapi/api_req_kaisou/slotset_ex',
  '/kcsapi/api_req_kaisou/slot_deprive',
  '/kcsapi/api_req_kaisou/unsetslot_all',
])
const FLEET_ACTION_PATH = '/kcsapi/api_req_hensei/change'
const BATTLE_RESULT_PATHS = new Set([
  '/kcsapi/api_req_practice/battle_result',
  '/kcsapi/api_req_sortie/battleresult',
  '/kcsapi/api_req_combined_battle/battleresult',
])
const BATTLE_PATHS = new Set([
  '/kcsapi/api_req_practice/battle',
  '/kcsapi/api_req_practice/midnight_battle',
  '/kcsapi/api_req_sortie/battle',
  '/kcsapi/api_req_sortie/airbattle',
  '/kcsapi/api_req_sortie/ld_airbattle',
  '/kcsapi/api_req_sortie/ld_shooting',
  '/kcsapi/api_req_battle_midnight/battle',
  '/kcsapi/api_req_battle_midnight/sp_midnight',
  '/kcsapi/api_req_combined_battle/battle',
  '/kcsapi/api_req_combined_battle/battle_water',
  '/kcsapi/api_req_combined_battle/airbattle',
  '/kcsapi/api_req_combined_battle/ld_airbattle',
  '/kcsapi/api_req_combined_battle/ld_shooting',
  '/kcsapi/api_req_combined_battle/ec_battle',
  '/kcsapi/api_req_combined_battle/each_battle',
  '/kcsapi/api_req_combined_battle/each_battle_water',
  '/kcsapi/api_req_combined_battle/midnight_battle',
  '/kcsapi/api_req_combined_battle/sp_midnight',
  '/kcsapi/api_req_combined_battle/ec_midnight_battle',
  '/kcsapi/api_req_combined_battle/ec_night_to_day',
])

function createPoiTelemetry(options = {}) {
  const now = options.now || (() => new Date())
  const actionEvents = createPoiActionEvents({ now })
  const apiResponses = createPoiApiResponses({ now })
  const availableQuestSessionId = String(
    options.questSessionId || crypto.randomUUID(),
  )
  let questGeneration = 0
  let questList = null
  let availableQuestGeneration = 0
  let availableQuestSnapshot = null
  let missionBoardGeneration = 0
  let missionBoard = null
  let questActionGeneration = 0
  let questAction = null
  let equipmentActionGeneration = 0
  let equipmentAction = null
  let equipmentSelectionGeneration = 0
  let equipmentSelection = null
  let unsetSlotGeneration = 0
  let unsetSlot = null
  let fleetActionGeneration = 0
  let fleetAction = null
  let battleGeneration = 0
  let battleTelemetry = null

  function handleGameResponse(event) {
    const detail = event && event.detail
    if (!detail || typeof detail.path !== 'string') return
    const actionEvent = actionEvents.capture(detail)
    apiResponses.capture(detail, actionEvent && actionEvent.capturedAt)

    if (QUEST_RECONNECT_PATHS.has(detail.path)) {
      if (successfulResponse(detail, actionEvent)) {
        invalidateAvailableQuestSnapshot(
          'reconnect',
          capturedAtOf(actionEvent, now),
        )
      }
      return
    }
    if (detail.path === QUEST_LIST_PATH) {
      captureQuestList(detail, actionEvent)
      captureAvailableQuestSnapshot(detail, actionEvent)
      return
    }
    if (detail.path === MISSION_BOARD_PATH) {
      captureMissionBoard(detail, actionEvent)
      return
    }
    if (detail.path === UNSET_SLOT_PATH) {
      captureUnsetSlot(detail, actionEvent)
      return
    }
    if (detail.path === EQUIPMENT_SELECTION_PATH) {
      captureEquipmentSelection(detail, actionEvent)
      return
    }
    if (QUEST_ACTION_PATHS.has(detail.path)) {
      captureQuestAction(detail, actionEvent)
      if (successfulResponse(detail, actionEvent)) {
        invalidateAvailableQuestSnapshot(
          'quest_action',
          capturedAtOf(actionEvent, now),
        )
      }
      return
    }
    if (EQUIPMENT_ACTION_PATHS.has(detail.path)) {
      captureEquipmentAction(detail, actionEvent)
      return
    }
    if (detail.path === FLEET_ACTION_PATH) {
      captureFleetAction(detail, actionEvent)
      return
    }
    if (BATTLE_RESULT_PATHS.has(detail.path)) {
      captureBattleResult(detail)
      return
    }
    if (BATTLE_PATHS.has(detail.path)) {
      captureBattlePacket(detail)
    }
  }

  function captureQuestList(detail, actionEvent) {
    const body = detail.body
    const postBody = detail.postBody
    const tabId = toInteger(postBody && postBody.api_tab_id)
    if (
      !body ||
      !Array.isArray(body.api_list) ||
      tabId == null ||
      tabId < 0 ||
      tabId > 9
    ) {
      return
    }

    const quests = body.api_list.flatMap((quest, index) => {
      if (!quest || typeof quest !== 'object' || !Number.isInteger(quest.api_no)) {
        return []
      }
      return [{ ...quest, listIndex: index + 1 }]
    })

    questGeneration += 1
    questList = {
      available: true,
      generation: questGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      tabId,
      pageNo: nonNegativeInteger(body.api_disp_page),
      pageCount: nonNegativeInteger(body.api_page_count),
      count: nonNegativeInteger(body.api_count),
      execCount: nonNegativeInteger(body.api_exec_count),
      execType: nonNegativeInteger(body.api_exec_type),
      quests,
    }
  }

  function captureAvailableQuestSnapshot(detail, actionEvent) {
    if (!successfulResponse(detail, actionEvent)) return
    const postBody = detail.postBody
    if (toInteger(postBody && postBody.api_tab_id) !== 0) return
    const body = detail.body
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Number.isSafeInteger(body.api_count) ||
      body.api_count < 0 ||
      !Array.isArray(body.api_list) ||
      body.api_count !== body.api_list.length
    ) {
      return
    }

    const questIds = new Set()
    const quests = []
    for (let index = 0; index < body.api_list.length; index += 1) {
      const quest = normalizeAvailableQuest(body.api_list[index], index)
      if (!quest || questIds.has(quest.api_no)) return
      questIds.add(quest.api_no)
      quests.push(quest)
    }

    const capturedAt = capturedAtOf(actionEvent, now)
    const capturedDate = validDate(capturedAt) || validDate(now()) || new Date()
    const ttlExpiry = capturedDate.getTime() + QUEST_SNAPSHOT_TTL_MS
    const dailyResetExpiry = nextQuestDailyReset(capturedDate.getTime())
    const expiresAtMilliseconds = Math.min(ttlExpiry, dailyResetExpiry)
    const expiryReason = dailyResetExpiry <= ttlExpiry
      ? 'daily_reset'
      : 'expired'

    availableQuestGeneration += 1
    availableQuestSnapshot = {
      sessionId: availableQuestSessionId,
      generation: availableQuestGeneration,
      available: true,
      complete: true,
      stale: false,
      staleReason: null,
      capturedAt: capturedDate.toISOString(),
      expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      invalidatedAt: null,
      source: QUEST_LIST_PATH,
      sourceTabId: 0,
      apiCount: body.api_count,
      execCount: nonNegativeInteger(body.api_exec_count),
      execType: nonNegativeInteger(body.api_exec_type),
      completedKind: nonNegativeInteger(body.api_completed_kind),
      snapshotTotal: quests.length,
      quests,
      expiryReason,
    }
  }

  function invalidateAvailableQuestSnapshot(reason, invalidatedAt) {
    if (!availableQuestSnapshot) return
    availableQuestGeneration += 1
    availableQuestSnapshot = {
      ...availableQuestSnapshot,
      generation: availableQuestGeneration,
      available: false,
      stale: true,
      staleReason: reason,
      invalidatedAt,
    }
  }

  function getAvailableQuestSnapshot() {
    if (!availableQuestSnapshot) {
      return {
        sessionId: availableQuestSessionId,
        generation: availableQuestGeneration,
        available: false,
        complete: false,
        stale: false,
        staleReason: 'not_loaded',
        capturedAt: null,
        expiresAt: null,
        invalidatedAt: null,
        source: QUEST_LIST_PATH,
        sourceTabId: 0,
        apiCount: null,
        execCount: null,
        execType: null,
        completedKind: null,
        snapshotTotal: 0,
        quests: [],
      }
    }

    const readAt = currentMilliseconds(now)
    if (
      !availableQuestSnapshot.stale &&
      Date.parse(availableQuestSnapshot.expiresAt) <= readAt
    ) {
      invalidateAvailableQuestSnapshot(
        availableQuestSnapshot.expiryReason,
        new Date(readAt).toISOString(),
      )
    }

    const { expiryReason: _expiryReason, ...snapshot } = availableQuestSnapshot
    return {
      ...snapshot,
      quests: snapshot.available && !snapshot.stale
        ? snapshot.quests.map(cloneAvailableQuest)
        : [],
    }
  }

  function captureMissionBoard(detail, actionEvent) {
    const body = detail.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return
    const source = body.api_data &&
      typeof body.api_data === 'object' &&
      !Array.isArray(body.api_data)
      ? body.api_data
      : body
    if (!Array.isArray(source.api_list_items)) return

    const items = source.api_list_items.flatMap((item) => {
      const missionId = positiveIntegerOrNull(item && item.api_mission_id)
      const state = toInteger(item && item.api_state)
      if (missionId == null || state == null || state < 0) return []
      return [{ missionId, state }]
    })
    if (items.length === 0) return

    missionBoardGeneration += 1
    missionBoard = {
      available: true,
      generation: missionBoardGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      items,
      limitTime: positiveIntegerOrNull(
        Array.isArray(source.api_limit_time)
          ? source.api_limit_time[0]
          : source.api_limit_time,
      ),
    }
  }

  function captureQuestAction(detail, actionEvent) {
    const apiResult = actionEvent
      ? actionEvent.apiResult
      : equipmentApiResult(detail)
    if (apiResult !== 1) return
    const postBody = detail.postBody
    const questId = toInteger(postBody && postBody.api_quest_id)
    if (questId == null || questId <= 0) return

    questActionGeneration += 1
    questAction = {
      available: true,
      generation: questActionGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      path: actionEvent ? actionEvent.path : detail.path,
      questId,
      flag: toInteger(postBody && postBody.api_quest_flag),
      selectedKind: selectedKindOf(postBody),
      apiResult,
    }
  }

  function captureEquipmentAction(detail, actionEvent) {
    const apiResult = actionEvent
      ? actionEvent.apiResult
      : equipmentApiResult(detail)
    if (apiResult === 0) return
    const postBody = normalizeEquipmentPostBody(detail.path, detail.postBody)
    if (!postBody) return

    equipmentActionGeneration += 1
    equipmentAction = {
      available: true,
      generation: equipmentActionGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      path: actionEvent ? actionEvent.path : detail.path,
      apiResult,
      postBody,
    }
  }

  function captureUnsetSlot(detail, actionEvent) {
    const bySlotType = normalizeUnsetSlotBody(detail.body)
    if (bySlotType == null) return

    unsetSlotGeneration += 1
    unsetSlot = {
      available: true,
      generation: unsetSlotGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      bySlotType,
      equipmentIds: Object.values(bySlotType)
        .flatMap((groups) => Object.values(groups))
        .flat(),
    }
  }

  function captureEquipmentSelection(detail, actionEvent) {
    const equipmentIds = normalizeEquipmentSelectionBody(detail.body)
    if (equipmentIds == null) return
    const postBody = normalizeEquipmentSelectionPostBody(detail.postBody)
    if (!postBody) return

    equipmentSelectionGeneration += 1
    equipmentSelection = {
      available: true,
      generation: equipmentSelectionGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      path: actionEvent ? actionEvent.path : detail.path,
      postBody,
      equipmentIds,
      count: equipmentIds.length,
    }
  }

  function captureFleetAction(detail, actionEvent) {
    const apiResult = actionEvent
      ? actionEvent.apiResult
      : equipmentApiResult(detail)
    if (apiResult === 0) return
    const postBody = normalizeFleetPostBody(detail.postBody)
    if (!postBody) return

    fleetActionGeneration += 1
    fleetAction = {
      available: true,
      generation: fleetActionGeneration,
      capturedAt: actionEvent
        ? actionEvent.capturedAt
        : now().toISOString(),
      path: actionEvent ? actionEvent.path : detail.path,
      apiResult,
      postBody,
    }
  }

  function captureBattlePacket(detail) {
    if (!battleTelemetry || battleTelemetry.status === 'settled') {
      battleGeneration += 1
    }
    battleTelemetry = {
      available: true,
      generation: battleGeneration,
      status: 'in_progress',
      observed: {
        capturedAt: now().toISOString(),
        path: detail.path,
        time: finiteOrNull(detail.time),
        phaseStartHp: {
          friendlyMain: numberArray(detail.body && detail.body.api_f_nowhps),
          friendlyEscort: numberArray(
            detail.body && detail.body.api_f_nowhps_combined,
          ),
          enemyMain: numberArray(detail.body && detail.body.api_e_nowhps),
          enemyEscort: numberArray(
            detail.body && detail.body.api_e_nowhps_combined,
          ),
        },
      },
      official: null,
    }
  }

  function captureBattleResult(detail) {
    if (!battleTelemetry) battleGeneration += 1
    const body = detail.body && typeof detail.body === 'object'
      ? detail.body
      : {}
    battleTelemetry = {
      available: true,
      generation: battleGeneration,
      status: 'settled',
      observed: battleTelemetry ? battleTelemetry.observed : null,
      official: {
        capturedAt: now().toISOString(),
        path: detail.path,
        time: finiteOrNull(detail.time),
        rank: typeof body.api_win_rank === 'string' ? body.api_win_rank : null,
        mvpPosition: {
          main: positiveIntegerOrNull(body.api_mvp),
          escort: positiveIntegerOrNull(body.api_mvp_combined),
        },
        drop: {
          ship: objectOrNull(body.api_get_ship),
          useItem: objectOrNull(body.api_get_useitem),
        },
      },
    }
  }

  return {
    handleGameResponse,
    getQuestList() {
      return questList || { available: false, generation: 0 }
    },
    getAvailableQuestSnapshot,
    getMissionBoard() {
      return missionBoard || { available: false, generation: 0 }
    },
    getQuestAction() {
      return questAction || { available: false, generation: 0 }
    },
    getEquipmentAction() {
      return equipmentAction || { available: false, generation: 0 }
    },
    getEquipmentSelection() {
      return equipmentSelection || { available: false, generation: 0 }
    },
    getUnsetSlot() {
      return unsetSlot || { available: false, generation: 0 }
    },
    getFleetAction() {
      return fleetAction || { available: false, generation: 0 }
    },
    getActionEvents(options) {
      return actionEvents.read(options)
    },
    getActionEventsWait(options) {
      return actionEvents.wait(options)
    },
    getApiResponses(options) {
      return apiResponses.read(options)
    },
    getBattleTelemetry() {
      return battleTelemetry || { available: false, generation: 0 }
    },
  }
}

function normalizeEquipmentSelectionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const source = body.api_data &&
    typeof body.api_data === 'object' &&
    !Array.isArray(body.api_data)
    ? body.api_data
    : body
  if (!Array.isArray(source.api_slotitem)) return null
  const ids = source.api_slotitem
    .map((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? positiveIntegerOrNull(item.api_id)
      : null)
  if (ids.some((id) => id == null) || ids.length > 10000) return null
  return ids
}

function normalizeEquipmentSelectionPostBody(postBody) {
  if (!postBody || typeof postBody !== 'object') return null
  const shipId = positiveIntegerOrNull(postBody.api_id)
  const slotIndex = boundedInteger(postBody.api_slot_idx, 0, 5)
  if (shipId == null || slotIndex == null) return null
  return {
    api_id: shipId,
    api_slot_idx: slotIndex,
  }
}

function normalizeUnsetSlotBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const source = body.api_data &&
    typeof body.api_data === 'object' &&
    !Array.isArray(body.api_data)
    ? body.api_data
    : body
  const output = {}
  let totalIds = 0

  for (const [slotType, groups] of Object.entries(source)) {
    if (!/^api_slottype\d+$/.test(slotType)) continue
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue
    const normalizedGroups = {}
    for (const [groupId, ids] of Object.entries(groups)) {
      if (!/^\d+$/.test(groupId) || !Array.isArray(ids)) continue
      const normalizedIds = ids
        .map(positiveIntegerOrNull)
        .filter((id) => id != null)
      totalIds += normalizedIds.length
      if (totalIds > 10000) return null
      normalizedGroups[groupId] = normalizedIds
    }
    if (Object.keys(normalizedGroups).length > 0) {
      output[slotType] = normalizedGroups
    }
  }
  return Object.keys(output).length > 0 ? output : null
}

function normalizeFleetPostBody(postBody) {
  if (!postBody || typeof postBody !== 'object') return null
  const fleetId = boundedInteger(postBody.api_id, 1, 4)
  const shipIndex = boundedInteger(postBody.api_ship_idx, 0, 5)
  const shipId = boundedInteger(postBody.api_ship_id, -1)
  if (fleetId == null || shipIndex == null || shipId == null) return null
  return {
    api_id: fleetId,
    api_ship_idx: shipIndex,
    api_ship_id: shipId,
  }
}

function normalizeEquipmentPostBody(path, postBody) {
  if (!postBody || typeof postBody !== 'object') return null
  if (path === '/kcsapi/api_req_kaisou/slotset') {
    const shipId = positiveIntegerOrNull(postBody.api_id)
    const slotIndex = boundedInteger(postBody.api_slot_idx, 0, 4)
    const itemId = boundedInteger(postBody.api_item_id, -1)
    if (shipId == null || slotIndex == null || itemId == null) return null
    return {
      api_id: shipId,
      api_slot_idx: slotIndex,
      api_item_id: itemId,
    }
  }
  if (path === '/kcsapi/api_req_kaisou/slotset_ex') {
    const shipId = positiveIntegerOrNull(postBody.api_id)
    const itemId = boundedInteger(postBody.api_item_id, -1)
    if (shipId == null || itemId == null) return null
    return {
      api_id: shipId,
      api_item_id: itemId,
    }
  }
  if (path === '/kcsapi/api_req_kaisou/slot_deprive') {
    const setShip = positiveIntegerOrNull(postBody.api_set_ship)
    const unsetShip = positiveIntegerOrNull(postBody.api_unset_ship)
    const setIndex = boundedInteger(postBody.api_set_idx, -1, 4)
    const unsetIndex = boundedInteger(postBody.api_unset_idx, -1, 4)
    if (
      setShip == null ||
      unsetShip == null ||
      setIndex == null ||
      unsetIndex == null
    ) {
      return null
    }
    return {
      api_set_ship: setShip,
      api_unset_ship: unsetShip,
      api_set_idx: setIndex,
      api_unset_idx: unsetIndex,
    }
  }
  if (path === '/kcsapi/api_req_kaisou/unsetslot_all') {
    const shipId = positiveIntegerOrNull(postBody.api_id)
    return shipId == null ? null : { api_id: shipId }
  }
  return null
}

function equipmentApiResult(detail) {
  const candidates = [
    detail.apiResult,
    detail.api_result,
    detail.result,
    detail.body && detail.body.api_result,
  ]
  for (const candidate of candidates) {
    const value = toInteger(candidate)
    if (value != null) return value === 1 ? 1 : 0
  }
  return null
}

function successfulResponse(detail, actionEvent) {
  return Boolean(
    (actionEvent && actionEvent.apiResult === 1) ||
    equipmentApiResult(detail) === 1,
  )
}

function capturedAtOf(actionEvent, now) {
  if (actionEvent && typeof actionEvent.capturedAt === 'string') {
    return actionEvent.capturedAt
  }
  const value = validDate(now()) || new Date()
  return value.toISOString()
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function currentMilliseconds(now) {
  const value = validDate(now())
  return value ? value.getTime() : Date.now()
}

function nextQuestDailyReset(milliseconds) {
  const jstMilliseconds = milliseconds + JST_OFFSET_MS
  const jst = new Date(jstMilliseconds)
  let resetJstMilliseconds = Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate(),
    5,
  )
  if (resetJstMilliseconds <= jstMilliseconds) {
    resetJstMilliseconds += ONE_DAY_MS
  }
  return resetJstMilliseconds - JST_OFFSET_MS
}

function normalizeAvailableQuest(quest, listIndex) {
  if (
    !quest ||
    typeof quest !== 'object' ||
    Array.isArray(quest) ||
    !Number.isSafeInteger(quest.api_no) ||
    quest.api_no <= 0
  ) {
    return null
  }
  return {
    api_no: quest.api_no,
    api_category: integerOrNull(quest.api_category),
    api_type: integerOrNull(quest.api_type),
    api_label_type: integerOrNull(quest.api_label_type),
    api_state: integerOrNull(quest.api_state),
    api_title: typeof quest.api_title === 'string' ? quest.api_title : '',
    api_detail: typeof quest.api_detail === 'string' ? quest.api_detail : '',
    api_voice_id: integerOrNull(quest.api_voice_id),
    api_get_material: cloneJsonArray(quest.api_get_material),
    api_bonus_flag: integerOrNull(quest.api_bonus_flag),
    api_progress_flag: integerOrNull(quest.api_progress_flag),
    api_invalid_flag: integerOrNull(quest.api_invalid_flag),
    listIndex,
  }
}

function cloneAvailableQuest(quest) {
  return {
    ...quest,
    api_get_material: cloneJsonArray(quest.api_get_material),
  }
}

function cloneJsonArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (item == null || typeof item !== 'object') return item
    try {
      return JSON.parse(JSON.stringify(item))
    } catch (_) {
      return null
    }
  })
}

function integerOrNull(value) {
  const parsed = toInteger(value)
  return parsed == null ? null : parsed
}

function boundedInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = toInteger(value)
  return parsed != null && parsed >= minimum && parsed <= maximum
    ? parsed
    : null
}

function selectedKindOf(postBody) {
  if (!postBody || typeof postBody !== 'object') return null
  const value = postBody.api_selected_kind
  if (value == null || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return null
}

function toInteger(value, fallback = null) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

function nonNegativeInteger(value) {
  const parsed = toInteger(value, 0)
  return parsed != null && parsed >= 0 ? parsed : 0
}

function positiveIntegerOrNull(value) {
  const parsed = toInteger(value)
  return parsed != null && parsed > 0 ? parsed : null
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function numberArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => finiteOrNull(item))
}

function objectOrNull(value) {
  return value && typeof value === 'object' ? { ...value } : null
}

module.exports = {
  QUEST_SNAPSHOT_TTL_MS,
  createPoiTelemetry,
  nextQuestDailyReset,
}
