const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  McpToolInputError,
  formatResourceHistory,
  validateResourceHistoryArgs,
} = require('../lib/mcp-tools')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const BASE_TIME = Date.parse('2026-09-01T00:00:00.000Z')

test('resource history input defaults to the previous 168 hours', () => {
  const input = validateResourceHistoryArgs({}, BASE_TIME)

  assert.equal(input.requestedEndMs, BASE_TIME)
  assert.equal(input.requestedStartMs, BASE_TIME - 168 * HOUR_MS)
  assert.equal(input.requestedEnd, '2026-09-01T00:00:00.000Z')
  assert.equal(input.includeSeries, false)
  assert.equal(input.maxPoints, 100)
})

test('resource history input supports relative hours and series options', () => {
  const input = validateResourceHistoryArgs({
    hours: 12.5,
    includeSeries: true,
    maxPoints: 25,
  }, BASE_TIME)

  assert.equal(input.requestedStartMs, BASE_TIME - 12.5 * HOUR_MS)
  assert.equal(input.includeSeries, true)
  assert.equal(input.maxPoints, 25)
})

test('resource history input supports absolute zoned date-times', () => {
  const input = validateResourceHistoryArgs({
    start: '2026-08-31T00:00:00+09:00',
    end: '2026-09-21T00:00:00+09:00',
  })

  assert.equal(input.requestedStart, '2026-08-30T15:00:00.000Z')
  assert.equal(input.requestedEnd, '2026-09-20T15:00:00.000Z')
})

test('resource history input rejects conflicting or incomplete periods', () => {
  assertInputError({ hours: 24, start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' })
  assertInputError({ start: '2026-09-01T00:00:00Z' })
  assertInputError({ end: '2026-09-02T00:00:00Z' })
  assertInputError({ start: '2026-09-02T00:00:00Z', end: '2026-09-02T00:00:00Z' })
  assertInputError({ start: '2026-09-03T00:00:00Z', end: '2026-09-02T00:00:00Z' })
})

test('resource history input rejects invalid and timezone-less date-times', () => {
  assertInputError({ start: 'not-a-date', end: '2026-09-02T00:00:00Z' })
  assertInputError({ start: '2026-09-01T00:00:00', end: '2026-09-02T00:00:00' })
  assertInputError({ start: '2026-02-30T00:00:00Z', end: '2026-03-02T00:00:00Z' })
})

test('resource history input validates hours, booleans, maxPoints, and unknown keys', () => {
  assertInputError({ hours: 0 })
  assertInputError({ hours: Number.NaN })
  assertInputError({ hours: Number.POSITIVE_INFINITY })
  assertInputError({ hours: Number.MAX_VALUE })
  assertInputError({ includeSeries: 1 })
  assertInputError({ maxPoints: 1 })
  assertInputError({ maxPoints: 501 })
  assertInputError({ maxPoints: 2.5 })
  assertInputError({ maxPoints: Number.NaN })
  assertInputError({ maxPoints: Number.POSITIVE_INFINITY })
  assertInputError({ unknown: true })
})

test('adapter unavailable states pass through as normal tool results', () => {
  const input = absoluteInput(BASE_TIME, BASE_TIME + DAY_MS)
  for (const state of [
    'disabled',
    'pluginUnavailable',
    'pluginNotReady',
    'stateUnavailable',
    'noHistory',
    'invalidData',
  ]) {
    const result = formatResourceHistory(input, { state, history: [] })
    assert.equal(result.state, state)
    assert.equal(result.source, 'poi-plugin-akashic-records')
    assert.equal(result.sampleCount, 0)
    assert.equal(result.actualStart, null)
    assert.equal(result.resources, null)
  }
})

test('available history with no sample in range is distinguished', () => {
  const input = absoluteInput(BASE_TIME, BASE_TIME + HOUR_MS)
  const result = formatResourceHistory(input, {
    state: 'available',
    history: [resourceSample(BASE_TIME + 2 * HOUR_MS, 100)],
  })

  assert.equal(result.state, 'noDataInRange')
  assert.equal(result.sampleCount, 0)
  assert.equal(result.actualStart, null)
})

test('one sample returns available values but no per-day rate', () => {
  const input = absoluteInput(BASE_TIME, BASE_TIME + 2 * HOUR_MS)
  const timestamp = BASE_TIME + HOUR_MS
  const result = formatResourceHistory(input, {
    state: 'available',
    history: [resourceSample(timestamp, 100)],
  })

  assert.equal(result.state, 'available')
  assert.equal(result.sampleCount, 1)
  assert.equal(result.actualDurationHours, 0)
  assert.equal(result.startGapMinutes, 60)
  assert.equal(result.endGapMinutes, 60)
  assert.deepEqual(result.resources.fuel, {
    start: 100,
    end: 100,
    delta: 0,
    netPerDay: null,
    min: { value: 100, timestamp: '2026-09-01T01:00:00.000Z' },
    max: { value: 100, timestamp: '2026-09-01T01:00:00.000Z' },
    maxDepletionFromStart: 0,
    observedIncrease: 0,
    observedDecrease: 0,
  })
  assert.equal(Object.hasOwn(result, 'series'), false)
  assert.equal(result.seriesTotalCount, 1)
  assert.equal(result.seriesReturnedCount, 0)
  assert.equal(result.seriesDownsampled, false)
  assert.deepEqual(result.sampling, {
    maxGapHours: null,
    gapCountOver2Hours: 0,
  })
})

test('summary uses inclusive boundaries, chronological changes, and actual duration', () => {
  const chronological = [
    resourceSample(BASE_TIME, 100, { ammo: 50 }),
    resourceSample(BASE_TIME + 6 * HOUR_MS, 120, { ammo: 40 }),
    resourceSample(BASE_TIME + 12 * HOUR_MS, 90, { ammo: 40 }),
    resourceSample(BASE_TIME + DAY_MS, 110, { ammo: 50 }),
  ]
  const history = [
    resourceSample(BASE_TIME + DAY_MS + HOUR_MS, 999),
    ...chronological.slice().reverse(),
    resourceSample(BASE_TIME - HOUR_MS, 1),
  ]
  const result = formatResourceHistory(
    absoluteInput(BASE_TIME, BASE_TIME + DAY_MS),
    { state: 'available', history },
  )

  assert.equal(result.sampleCount, 4)
  assert.equal(result.actualStart, '2026-09-01T00:00:00.000Z')
  assert.equal(result.actualEnd, '2026-09-02T00:00:00.000Z')
  assert.equal(result.startGapMinutes, 0)
  assert.equal(result.endGapMinutes, 0)
  assert.equal(result.actualDurationHours, 24)
  assert.deepEqual(result.sampling, {
    maxGapHours: 12,
    gapCountOver2Hours: 3,
  })
  assert.deepEqual(result.resources.fuel, {
    start: 100,
    end: 110,
    delta: 10,
    netPerDay: 10,
    min: { value: 90, timestamp: '2026-09-01T12:00:00.000Z' },
    max: { value: 120, timestamp: '2026-09-01T06:00:00.000Z' },
    maxDepletionFromStart: 10,
    observedIncrease: 40,
    observedDecrease: 30,
  })
  assert.equal(result.resources.ammo.min.timestamp, '2026-09-01T06:00:00.000Z')
  assert.equal(result.resources.ammo.max.timestamp, '2026-09-01T00:00:00.000Z')
  assert.deepEqual(Object.keys(result.resources), [
    'fuel',
    'ammo',
    'steel',
    'bauxite',
    'instantBuild',
    'instantRepair',
    'developmentMaterial',
    'improvementMaterial',
  ])
  assert.equal(result.measurement.captureTrigger, 'kcsapiPortObservation')
  assert.equal(result.measurement.bucketPolicy, 'atMostOneRecordPerHourBucket')
  assert.equal(result.measurement.fixedInterval, false)
  assert.equal(result.measurement.mayHaveGaps, true)
  assert.equal(result.measurement.transactionLog, false)
})

test('series is chronological and returned in full below maxPoints', () => {
  const history = [
    resourceSample(BASE_TIME + 2 * HOUR_MS, 120),
    resourceSample(BASE_TIME + HOUR_MS, 110),
    resourceSample(BASE_TIME, 100),
  ]
  const input = validateResourceHistoryArgs({
    start: '2026-09-01T00:00:00Z',
    end: '2026-09-01T02:00:00Z',
    includeSeries: true,
    maxPoints: 10,
  })
  const result = formatResourceHistory(input, { state: 'available', history })

  assert.deepEqual(result.series.map(({ timestamp }) => timestamp), [
    BASE_TIME,
    BASE_TIME + HOUR_MS,
    BASE_TIME + 2 * HOUR_MS,
  ])
  assert.equal(result.order, 'chronological-oldest-first')
  assert.equal(result.seriesTotalCount, 3)
  assert.equal(result.seriesReturnedCount, 3)
  assert.equal(result.seriesDownsampled, false)
})

test('downsampling is deterministic, keeps endpoints, and summarizes all samples', () => {
  const chronological = Array.from({ length: 6 }, (_, index) =>
    resourceSample(BASE_TIME + index * HOUR_MS, index === 2 ? -100 : 100 + index),
  )
  const history = chronological.slice().reverse()
  const snapshot = history.map((sample) => ({ ...sample }))
  const input = validateResourceHistoryArgs({
    start: '2026-09-01T00:00:00Z',
    end: '2026-09-01T05:00:00Z',
    includeSeries: true,
    maxPoints: 3,
  })

  const first = formatResourceHistory(input, { state: 'available', history })
  const second = formatResourceHistory(input, { state: 'available', history })

  assert.deepEqual(first.series.map(({ timestamp }) => timestamp), [
    BASE_TIME,
    BASE_TIME + 3 * HOUR_MS,
    BASE_TIME + 5 * HOUR_MS,
  ])
  assert.deepEqual(second.series, first.series)
  assert.equal(first.seriesTotalCount, 6)
  assert.equal(first.seriesReturnedCount, 3)
  assert.equal(first.seriesDownsampled, true)
  assert.equal(first.resources.fuel.min.value, -100)
  assert.equal(first.resources.fuel.min.timestamp, '2026-09-01T02:00:00.000Z')
  assert.deepEqual(first.sampling, {
    maxGapHours: 1,
    gapCountOver2Hours: 0,
  })
  assert.deepEqual(history, snapshot)
})

function absoluteInput(start, end) {
  return validateResourceHistoryArgs({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  })
}

function resourceSample(timestamp, fuel, overrides = {}) {
  return {
    timestamp,
    fuel,
    ammo: fuel,
    steel: fuel,
    bauxite: fuel,
    instantBuild: fuel,
    instantRepair: fuel,
    developmentMaterial: fuel,
    improvementMaterial: fuel,
    ...overrides,
  }
}

function assertInputError(args) {
  assert.throws(
    () => validateResourceHistoryArgs(args, BASE_TIME),
    McpToolInputError,
  )
}
