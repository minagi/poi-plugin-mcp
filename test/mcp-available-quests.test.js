const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  McpToolInputError,
  formatAvailableQuests,
  validateAvailableQuestsArgs,
} = require('../lib/mcp-tools')
const {
  QUEST_SNAPSHOT_TTL_MS,
  createPoiTelemetry,
  nextQuestDailyReset,
} = require('../lib/poi-telemetry')
const {
  createAvailableQuestSnapshotFixture,
  createQuestFixture,
  createQuestListDetail,
} = require('./fixtures')

test('canonical quest snapshot starts unavailable without exposing quest text', () => {
  const telemetry = createPoiTelemetry({
    now: () => new Date('2026-10-01T00:00:00.000Z'),
    questSessionId: 'quest-session-a',
  })
  const snapshot = telemetry.getAvailableQuestSnapshot()
  assert.equal(snapshot.available, false)
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.stale, false)
  assert.equal(snapshot.staleReason, 'not_loaded')
  assert.equal(snapshot.sessionId, 'quest-session-a')
  assert.deepEqual(snapshot.quests, [])

  const result = formatAvailableQuests({}, snapshot)
  assert.equal(result.total, null)
  assert.equal(result.returned, 0)
  assert.match(result.refreshHint, /All Quests/u)
})

test('only a valid successful tab zero response atomically replaces the canonical snapshot', () => {
  let current = Date.parse('2026-10-01T00:00:00.000Z')
  const telemetry = createPoiTelemetry({
    now: () => new Date(current),
    questSessionId: 'quest-session-b',
  })
  telemetry.handleGameResponse({ detail: createQuestListDetail() })
  const first = telemetry.getAvailableQuestSnapshot()
  assert.equal(first.available, true)
  assert.equal(first.complete, true)
  assert.equal(first.snapshotTotal, 80)
  assert.equal(first.quests.length, 80)
  assert.equal(first.quests[0].listIndex, 0)
  assert.equal(first.generation, 1)

  current += 1000
  telemetry.handleGameResponse({ detail: createQuestListDetail({
    tabId: 1,
    quests: first.quests.slice(0, 7),
  }) })
  telemetry.handleGameResponse({ detail: createQuestListDetail({
    tabId: 2,
    quests: first.quests.slice(7, 15),
  }) })
  const afterIndividualTabs = telemetry.getAvailableQuestSnapshot()
  assert.equal(afterIndividualTabs.generation, 1)
  assert.equal(afterIndividualTabs.snapshotTotal, 80)
  assert.equal(afterIndividualTabs.quests.length, 80)

  current += 1000
  telemetry.handleGameResponse({ detail: createQuestListDetail({
    count: 3,
    quests: [
      createQuestFixture(900),
      createQuestFixture(901),
      createQuestFixture(902),
    ],
  }) })
  const replaced = telemetry.getAvailableQuestSnapshot()
  assert.equal(replaced.generation, 2)
  assert.deepEqual(replaced.quests.map((quest) => quest.api_no), [900, 901, 902])
})

test('malformed tab zero responses never damage a fresh canonical snapshot', () => {
  const telemetry = createPoiTelemetry({
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  })
  telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 4 }) })
  const baseline = telemetry.getAvailableQuestSnapshot()

  telemetry.handleGameResponse({ detail: createQuestListDetail({
    count: 2,
    apiCount: 3,
  }) })
  telemetry.handleGameResponse({ detail: createQuestListDetail({
    quests: [createQuestFixture(1), createQuestFixture(1)],
  }) })
  telemetry.handleGameResponse({ detail: createQuestListDetail({
    quests: [createQuestFixture(1), null],
  }) })
  telemetry.handleGameResponse({ detail: createQuestListDetail({
    count: 1,
    apiResult: 0,
  }) })

  assert.deepEqual(telemetry.getAvailableQuestSnapshot(), baseline)

  const emptyTelemetry = createPoiTelemetry({
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  })
  emptyTelemetry.handleGameResponse({ detail: createQuestListDetail({
    count: 1,
    apiCount: 2,
  }) })
  assert.equal(emptyTelemetry.getAvailableQuestSnapshot().available, false)
})

test('successful quest actions invalidate while failed actions preserve the snapshot', () => {
  for (const action of ['start', 'stop', 'clearitemget']) {
    let current = Date.parse('2026-10-01T00:00:00.000Z')
    const telemetry = createPoiTelemetry({ now: () => new Date(current) })
    telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 3 }) })

    current += 1000
    telemetry.handleGameResponse({ detail: {
      path: `/kcsapi/api_req_quest/${action}`,
      apiResult: 0,
      postBody: { api_quest_id: '1' },
      body: {},
    } })
    assert.equal(telemetry.getAvailableQuestSnapshot().available, true)
    assert.equal(telemetry.getAvailableQuestSnapshot().generation, 1)

    current += 1000
    telemetry.handleGameResponse({ detail: {
      path: `/kcsapi/api_req_quest/${action}`,
      apiResult: 1,
      postBody: { api_quest_id: '1' },
      body: {},
    } })
    const stale = telemetry.getAvailableQuestSnapshot()
    assert.equal(stale.available, false)
    assert.equal(stale.complete, true)
    assert.equal(stale.stale, true)
    assert.equal(stale.staleReason, 'quest_action')
    assert.equal(stale.generation, 2)
    assert.deepEqual(stale.quests, [])

    current += 1000
    telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 2 }) })
    const refreshed = telemetry.getAvailableQuestSnapshot()
    assert.equal(refreshed.available, true)
    assert.equal(refreshed.stale, false)
    assert.equal(refreshed.generation, 3)
  }
})

test('bootstrap responses invalidate snapshots but ordinary port responses do not', () => {
  for (const reconnectPath of [
    '/kcsapi/api_start2/getData',
    '/kcsapi/api_get_member/require_info',
  ]) {
    const telemetry = createPoiTelemetry({
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    })
    telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 2 }) })
    telemetry.handleGameResponse({ detail: {
      path: reconnectPath,
      apiResult: 1,
      body: {},
      postBody: {},
    } })
    const stale = telemetry.getAvailableQuestSnapshot()
    assert.equal(stale.staleReason, 'reconnect')
    assert.equal(stale.available, false)
  }

  const telemetry = createPoiTelemetry({
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  })
  telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 2 }) })
  telemetry.handleGameResponse({ detail: {
    path: '/kcsapi/api_port/port',
    apiResult: 1,
    body: {},
    postBody: {},
  } })
  assert.equal(telemetry.getAvailableQuestSnapshot().available, true)
})

test('five minute TTL expires exactly at the boundary', () => {
  let current = Date.parse('2026-10-01T00:00:00.000Z')
  const telemetry = createPoiTelemetry({ now: () => new Date(current) })
  telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 2 }) })
  const captured = telemetry.getAvailableQuestSnapshot()
  assert.equal(
    Date.parse(captured.expiresAt) - Date.parse(captured.capturedAt),
    QUEST_SNAPSHOT_TTL_MS,
  )

  current += QUEST_SNAPSHOT_TTL_MS - 1000
  assert.equal(telemetry.getAvailableQuestSnapshot().available, true)
  current += 1000
  const expired = telemetry.getAvailableQuestSnapshot()
  assert.equal(expired.available, false)
  assert.equal(expired.staleReason, 'expired')
  assert.equal(expired.generation, 2)
  assert.deepEqual(expired.quests, [])
})

test('05:00 JST boundary is timezone-independent and wins over TTL', () => {
  const capturedAt = Date.parse('2026-10-01T19:57:00.000Z')
  assert.equal(
    new Date(nextQuestDailyReset(capturedAt)).toISOString(),
    '2026-10-01T20:00:00.000Z',
  )
  let current = capturedAt
  const telemetry = createPoiTelemetry({ now: () => new Date(current) })
  telemetry.handleGameResponse({ detail: createQuestListDetail({ count: 2 }) })
  assert.equal(
    telemetry.getAvailableQuestSnapshot().expiresAt,
    '2026-10-01T20:00:00.000Z',
  )
  current = Date.parse('2026-10-01T19:59:59.999Z')
  assert.equal(telemetry.getAvailableQuestSnapshot().available, true)
  current += 1
  const stale = telemetry.getAvailableQuestSnapshot()
  assert.equal(stale.available, false)
  assert.equal(stale.staleReason, 'daily_reset')
})

test('available quest filters use union within categories and AND across categories', () => {
  const snapshot = createAvailableQuestSnapshotFixture({ count: 30 })
  const result = formatAvailableQuests({
    questId: 1,
    questIds: [10, 20],
    state: 1,
    states: [2, 3],
    type: 1,
    types: [2],
    category: 2,
    categories: [10],
    invalidFlag: 0,
    invalidFlags: [1],
    limit: 100,
  }, snapshot)
  assert.deepEqual(result.quests.map((quest) => quest.questId), [1, 20])
  assert.equal(result.quests[0].stateName, 'unselected')
  assert.equal(Object.hasOwn(result.quests[0], 'api_no'), false)
  assert.equal(Object.hasOwn(result.quests[0], 'api_tab_id'), false)
})

test('available quest summary is computed before pagination and can be summary-only', () => {
  const snapshot = createAvailableQuestSnapshotFixture({ count: 80 })
  const defaultPage = formatAvailableQuests({}, snapshot)
  assert.equal(defaultPage.returned, 50)
  assert.equal(defaultPage.hasMore, true)
  assert.equal(defaultPage.quests.find((quest) => quest.questId === 10).stateName, 'in_progress')
  assert.equal(defaultPage.quests.find((quest) => quest.questId === 20).stateName, 'completed')

  const summaryOnly = formatAvailableQuests({ summary: true }, snapshot)
  assert.equal(summaryOnly.total, 80)
  assert.equal(summaryOnly.returned, 0)
  assert.deepEqual(summaryOnly.quests, [])
  assert.equal(summaryOnly.summary.total, 80)
  assert.equal(
    summaryOnly.summary.unselectedCount +
      summaryOnly.summary.inProgressCount +
      summaryOnly.summary.completedCount,
    80,
  )
  assert.ok(summaryOnly.summary.byState.length > 0)
  assert.ok(summaryOnly.summary.byType.length > 0)
  assert.ok(summaryOnly.summary.byCategory.length > 0)
  assert.ok(summaryOnly.summary.byInvalidFlag.length > 1)

  const summaryPage = formatAvailableQuests({ summary: true, limit: 5 }, snapshot)
  assert.equal(summaryPage.returned, 5)
  assert.equal(summaryPage.summary.total, 80)
})

test('available quest keyset cursor binds filters, session, and snapshot generation', () => {
  const snapshot = createAvailableQuestSnapshotFixture({ count: 80 })
  const first = formatAvailableQuests({ type: 1, limit: 3 }, snapshot)
  assert.equal(first.returned, 3)
  assert.equal(first.hasMore, true)
  const second = formatAvailableQuests({
    type: 1,
    limit: 3,
    cursor: first.nextCursor,
  }, snapshot)
  assert.ok(second.quests[0].questId > first.quests.at(-1).questId)

  assert.throws(
    () => formatAvailableQuests({ type: 2, cursor: first.nextCursor }, snapshot),
    McpToolInputError,
  )
  assert.throws(
    () => formatAvailableQuests({ type: 1, cursor: first.nextCursor }, {
      ...snapshot,
      generation: 2,
    }),
    /different quest snapshot generation/u,
  )
  assert.throws(
    () => formatAvailableQuests({ type: 1, cursor: first.nextCursor }, {
      ...snapshot,
      sessionId: 'different-session',
    }),
    /different quest snapshot session/u,
  )
})

test('TTL or daily expiry returns stale metadata instead of cursor errors or quest text', () => {
  const snapshot = createAvailableQuestSnapshotFixture({ count: 10 })
  const first = formatAvailableQuests({ limit: 3 }, snapshot)
  for (const staleReason of ['expired', 'daily_reset']) {
    const stale = formatAvailableQuests({ limit: 3, cursor: first.nextCursor }, {
      ...snapshot,
      generation: 2,
      available: false,
      stale: true,
      staleReason,
      invalidatedAt: '2026-09-30T00:05:00.000Z',
      quests: [],
    })
    assert.equal(stale.available, false)
    assert.equal(stale.total, null)
    assert.equal(stale.nextCursor, null)
    assert.deepEqual(stale.quests, [])
    assert.match(stale.refreshHint, /All Quests/u)
  }

  assert.throws(
    () => formatAvailableQuests({ limit: 3, cursor: first.nextCursor }, {
      ...snapshot,
      generation: 3,
      available: false,
      stale: true,
      staleReason: 'expired',
      quests: [],
    }),
    /different quest snapshot generation/u,
  )
})

test('available quest validation rejects unknown properties and invalid limits', () => {
  assert.throws(
    () => validateAvailableQuestsArgs({ unknown: true }),
    McpToolInputError,
  )
  assert.throws(
    () => validateAvailableQuestsArgs({ limit: 0 }),
    /requires summary:true/u,
  )
  assert.throws(
    () => validateAvailableQuestsArgs({ limit: 101 }),
    /0 to 100/u,
  )
  assert.throws(
    () => validateAvailableQuestsArgs({ state: 4 }),
    McpToolInputError,
  )
  assert.throws(
    () => validateAvailableQuestsArgs({ types: [1, null] }),
    McpToolInputError,
  )
  assert.throws(
    () => formatAvailableQuests({ cursor: 'not-json' }, createAvailableQuestSnapshotFixture()),
    /valid opaque cursor/u,
  )
})
