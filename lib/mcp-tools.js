const crypto = require('node:crypto')

const CURSOR_VERSION = 1
const DEFAULT_SEARCH_LIMIT = 100
const MAX_SEARCH_LIMIT = 200
const DEFAULT_ACTION_EVENTS_LIMIT = 20
const MAX_ACTION_EVENTS_LIMIT = 64
const DEFAULT_KCSAPI_RESPONSES_LIMIT = 3
const MAX_KCSAPI_RESPONSES_LIMIT = 10
const DEFAULT_AVAILABLE_QUESTS_LIMIT = 50
const MAX_AVAILABLE_QUESTS_LIMIT = 100
const DEFAULT_RESOURCE_HISTORY_HOURS = 168
const DEFAULT_RESOURCE_HISTORY_MAX_POINTS = 100
const MAX_RESOURCE_HISTORY_POINTS = 500
const MAX_MCP_RESPONSE_BODY_BYTES = 256 * 1024
const MAX_MCP_TOOL_RESULT_BYTES = 1024 * 1024
const AVAILABLE_QUESTS_REFRESH_HINT =
  'Open or refresh the All Quests tab in the game to capture a fresh quest snapshot.'
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

const RESOURCE_HISTORY_FIELDS = Object.freeze([
  'fuel',
  'ammo',
  'steel',
  'bauxite',
  'instantBuild',
  'instantRepair',
  'developmentMaterial',
  'improvementMaterial',
])

const RESOURCE_HISTORY_MEASUREMENT = Object.freeze({
  type: 'resourceSnapshot',
  captureTrigger: 'kcsapiPortObservation',
  bucketPolicy: 'atMostOneRecordPerHourBucket',
  fixedInterval: false,
  mayHaveGaps: true,
  transactionLog: false,
  deltaSemantics: 'netObservedBetweenSnapshots',
  description:
    'A snapshot is saved when /kcsapi/api_port/port is observed after the hour bucket changes. At most one record is kept per hour bucket, so unobserved hours can be missing. Changes between snapshots are net observed changes, not transaction-level income or consumption.',
  extremeTimestampPolicy: 'earliestOccurrence',
})

const ISO_DATE_TIME_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/u

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
    name: 'get_resource_history',
    description:
      'Summarize normalized Akashic Records resource snapshots for a relative or absolute period. Requires the read-only Logbook integration to be enabled. Snapshots are captured on /kcsapi/api_port/port observation, at most once per hour bucket, and may have gaps. observedIncrease and observedDecrease are net changes seen between snapshots, not actual transaction income or consumption.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          exclusiveMinimum: 0,
          default: DEFAULT_RESOURCE_HISTORY_HOURS,
          description: 'Relative period ending at tool execution time. Cannot be combined with start or end.',
        },
        start: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$',
          description: 'Inclusive absolute period start with an explicit timezone. Requires end.',
        },
        end: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$',
          description: 'Inclusive absolute period end with an explicit timezone. Requires start.',
        },
        includeSeries: { type: 'boolean', default: false },
        maxPoints: {
          type: 'integer',
          minimum: 2,
          maximum: MAX_RESOURCE_HISTORY_POINTS,
          default: DEFAULT_RESOURCE_HISTORY_MAX_POINTS,
          description: 'Maximum returned series points when includeSeries is true.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_quests',
    description:
      'Get accepted quests and quest progress records held by the Poi store. This is not the complete list of all currently available quests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_available_quests',
    description:
      'Read the latest fresh snapshot captured from the game All Quests tab. It includes displayed unselected, in-progress, and completed quests, but excludes hidden unmet quests, quest history, and the complete quest master list. Stale snapshots return metadata only and never return old quest text.',
    inputSchema: {
      type: 'object',
      properties: {
        questId: { type: 'integer', minimum: 1 },
        questIds: positiveIntegerArraySchema(),
        state: { type: 'integer', enum: [1, 2, 3] },
        states: {
          type: 'array',
          items: { type: 'integer', enum: [1, 2, 3] },
          uniqueItems: true,
        },
        type: { type: 'integer', minimum: 0 },
        types: nonNegativeIntegerArraySchema(),
        category: { type: 'integer', minimum: 0 },
        categories: nonNegativeIntegerArraySchema(),
        invalidFlag: { type: 'integer', minimum: 0 },
        invalidFlags: nonNegativeIntegerArraySchema(),
        limit: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_AVAILABLE_QUESTS_LIMIT,
          description: 'Default 50, or 0 when summary is true and limit is omitted. Zero requires summary:true.',
        },
        cursor: { type: 'string', minLength: 1, maxLength: 512 },
        summary: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
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
  {
    name: 'get_battle',
    description:
      'Get the single battle state currently or most recently retained by Poi. This is not battle history. A retained in_progress state can be stale when a battle result was not observed. Prophet prediction is optional, and missing Prophet data is a normal result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_action_events',
    description:
      'Read successful retained KCSAPI action events in generation order. The in-memory ring buffer can lose older events; pass the previous sessionId and after value to detect session changes or cursor loss.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ACTION_EVENTS_LIMIT, default: DEFAULT_ACTION_EVENTS_LIMIT },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_kcsapi_responses',
    description:
      'Read retained responses for one exact /kcsapi/ path. postBody is never returned. Older global response generations may have been evicted; cursorLost means responses for the requested path may have been among them. Response bodies are subject to MCP-specific size limits.',
    inputSchema: {
      type: 'object',
      properties: {
        apiPath: {
          type: 'string',
          minLength: 9,
          maxLength: 512,
          pattern: '^/kcsapi/[A-Za-z0-9_/-]+$',
        },
        after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_KCSAPI_RESPONSES_LIMIT, default: DEFAULT_KCSAPI_RESPONSES_LIMIT },
      },
      required: ['apiPath'],
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

function validateResourceHistoryArgs(args, now = Date.now()) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set([
    'hours', 'start', 'end', 'includeSeries', 'maxPoints',
  ]))

  const hasHours = args.hours != null
  const hasStart = args.start != null
  const hasEnd = args.end != null
  if (hasHours && (hasStart || hasEnd)) {
    throw new McpToolInputError('hours cannot be combined with start or end')
  }
  if (hasStart !== hasEnd) {
    throw new McpToolInputError('start and end must be provided together')
  }

  let requestedStartMs
  let requestedEndMs
  if (hasStart) {
    requestedStartMs = parseZonedIsoDateTime(args.start, 'start')
    requestedEndMs = parseZonedIsoDateTime(args.end, 'end')
    if (requestedStartMs >= requestedEndMs) {
      throw new McpToolInputError('start must be earlier than end')
    }
  } else {
    const hours = hasHours
      ? optionalFiniteNumber(args.hours, 'hours')
      : DEFAULT_RESOURCE_HISTORY_HOURS
    if (hours <= 0) {
      throw new McpToolInputError('hours must be greater than 0')
    }
    if (!Number.isFinite(now)) {
      throw new Error('Resource history clock is unavailable')
    }
    requestedEndMs = now
    requestedStartMs = requestedEndMs - hours * 60 * 60 * 1000
    if (!isSupportedTimestamp(requestedStartMs) || !isSupportedTimestamp(requestedEndMs)) {
      throw new McpToolInputError('hours produces an unsupported date range')
    }
  }

  const includeSeries = optionalBoolean(args.includeSeries, 'includeSeries') || false
  const maxPoints = args.maxPoints == null
    ? DEFAULT_RESOURCE_HISTORY_MAX_POINTS
    : optionalInteger(args.maxPoints, 'maxPoints', 2)
  if (maxPoints > MAX_RESOURCE_HISTORY_POINTS) {
    throw new McpToolInputError(
      `maxPoints must be an integer from 2 to ${MAX_RESOURCE_HISTORY_POINTS}`,
    )
  }

  return {
    requestedStartMs,
    requestedEndMs,
    requestedStart: new Date(requestedStartMs).toISOString(),
    requestedEnd: new Date(requestedEndMs).toISOString(),
    includeSeries,
    maxPoints,
  }
}

function formatResourceHistory(input, adapterResult = {}) {
  const state = typeof adapterResult.state === 'string'
    ? adapterResult.state
    : 'stateUnavailable'
  const result = resourceHistoryResultBase(input, state)
  if (state !== 'available') return result

  const samples = selectResourceHistoryRange(
    adapterResult.history,
    input.requestedStartMs,
    input.requestedEndMs,
  )
  if (samples.length === 0) {
    result.state = 'noDataInRange'
    return result
  }

  const first = samples[0]
  const last = samples[samples.length - 1]
  const durationMs = last.timestamp - first.timestamp
  result.state = 'available'
  result.actualStart = new Date(first.timestamp).toISOString()
  result.actualEnd = new Date(last.timestamp).toISOString()
  result.startGapMinutes = (first.timestamp - input.requestedStartMs) / (60 * 1000)
  result.endGapMinutes = (input.requestedEndMs - last.timestamp) / (60 * 1000)
  result.sampleCount = samples.length
  result.actualDurationHours = durationMs / (60 * 60 * 1000)
  result.resources = summarizeResourceSamples(samples, durationMs)
  result.sampling = summarizeResourceSampling(samples)
  result.seriesTotalCount = samples.length

  if (input.includeSeries) {
    result.series = downsampleResourceSeries(samples, input.maxPoints)
    result.seriesReturnedCount = result.series.length
    result.seriesDownsampled = result.series.length < samples.length
  }
  return result
}

function resourceHistoryResultBase(input, state) {
  return {
    state,
    source: 'poi-plugin-akashic-records',
    measurement: RESOURCE_HISTORY_MEASUREMENT,
    requestedStart: input.requestedStart,
    requestedEnd: input.requestedEnd,
    actualStart: null,
    actualEnd: null,
    startGapMinutes: null,
    endGapMinutes: null,
    sampleCount: 0,
    actualDurationHours: null,
    resources: null,
    sampling: {
      maxGapHours: null,
      gapCountOver2Hours: 0,
    },
    order: 'chronological-oldest-first',
    seriesTotalCount: 0,
    seriesReturnedCount: 0,
    seriesDownsampled: false,
  }
}

function selectResourceHistoryRange(history, requestedStartMs, requestedEndMs) {
  const source = Array.isArray(history) ? history : []
  const samples = []
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const sample = source[index]
    if (!sample || !Number.isFinite(sample.timestamp)) continue
    if (sample.timestamp < requestedStartMs) continue
    if (sample.timestamp > requestedEndMs) break
    samples.push(sample)
  }
  return samples
}

function summarizeResourceSamples(samples, durationMs) {
  const first = samples[0]
  const last = samples[samples.length - 1]
  const durationDays = durationMs > 0 ? durationMs / (24 * 60 * 60 * 1000) : null
  const resources = {}

  for (const field of RESOURCE_HISTORY_FIELDS) {
    let minimum = { value: first[field], timestamp: first.timestamp }
    let maximum = { value: first[field], timestamp: first.timestamp }
    let observedIncrease = 0
    let observedDecrease = 0

    for (let index = 1; index < samples.length; index += 1) {
      const current = samples[index]
      const previous = samples[index - 1]
      if (current[field] < minimum.value) {
        minimum = { value: current[field], timestamp: current.timestamp }
      }
      if (current[field] > maximum.value) {
        maximum = { value: current[field], timestamp: current.timestamp }
      }
      const change = current[field] - previous[field]
      if (change > 0) observedIncrease += change
      if (change < 0) observedDecrease += Math.abs(change)
    }

    const delta = last[field] - first[field]
    resources[field] = {
      start: first[field],
      end: last[field],
      delta,
      netPerDay: durationDays == null ? null : delta / durationDays,
      min: {
        value: minimum.value,
        timestamp: new Date(minimum.timestamp).toISOString(),
      },
      max: {
        value: maximum.value,
        timestamp: new Date(maximum.timestamp).toISOString(),
      },
      maxDepletionFromStart: Math.max(0, first[field] - minimum.value),
      observedIncrease,
      observedDecrease,
    }
  }
  return resources
}

function summarizeResourceSampling(samples) {
  if (samples.length <= 1) {
    return {
      maxGapHours: null,
      gapCountOver2Hours: 0,
    }
  }

  let maxGapHours = 0
  let gapCountOver2Hours = 0
  for (let index = 1; index < samples.length; index += 1) {
    const gapHours = (samples[index].timestamp - samples[index - 1].timestamp) /
      (60 * 60 * 1000)
    maxGapHours = Math.max(maxGapHours, gapHours)
    if (gapHours > 2) gapCountOver2Hours += 1
  }
  return { maxGapHours, gapCountOver2Hours }
}

function downsampleResourceSeries(samples, maxPoints) {
  if (samples.length <= maxPoints) return samples.slice()

  const selected = []
  const lastIndex = samples.length - 1
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(index * lastIndex / (maxPoints - 1))
    selected.push(samples[sourceIndex])
  }
  return selected
}

function parseZonedIsoDateTime(value, name) {
  if (typeof value !== 'string') {
    throw new McpToolInputError(`${name} must be an ISO date-time string with a timezone`)
  }
  const match = ISO_DATE_TIME_WITH_TIMEZONE.exec(value)
  if (!match || !validIsoDateTimeParts(match)) {
    throw new McpToolInputError(`${name} must be a valid ISO date-time with a timezone`)
  }
  const timestamp = Date.parse(value)
  if (!isSupportedTimestamp(timestamp)) {
    throw new McpToolInputError(`${name} must be a valid ISO date-time with a timezone`)
  }
  return timestamp
}

function validIsoDateTimeParts(match) {
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] == null ? 0 : Number(match[8])
  const offsetMinute = match[9] == null ? 0 : Number(match[9])
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth &&
    hour >= 0 && hour <= 23 &&
    minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 59 &&
    offsetHour >= 0 && offsetHour <= 23 &&
    offsetMinute >= 0 && offsetMinute <= 59
}

function isSupportedTimestamp(value) {
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15
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

function formatAvailableQuests(args = {}, raw = {}) {
  const validated = validateAvailableQuestsArgs(args)
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId : null
  const generation = generationValue(source.generation)
  const cursorPayload = args.cursor == null
    ? null
    : decodeAvailableQuestCursor(args.cursor, validated.filterHash)

  if (cursorPayload && cursorPayload.sessionId !== sessionId) {
    throw new McpToolInputError('cursor belongs to a different quest snapshot session')
  }

  const staleReason = typeof source.staleReason === 'string'
    ? source.staleReason
    : null
  const available = source.available === true &&
    source.complete === true &&
    source.stale !== true
  const expiryStale = source.stale === true &&
    (staleReason === 'expired' || staleReason === 'daily_reset')

  if (cursorPayload && cursorPayload.snapshotGeneration !== generation) {
    const cursorWasCurrentBeforeExpiry = expiryStale &&
      cursorPayload.snapshotGeneration === generation - 1
    if (!cursorWasCurrentBeforeExpiry) {
      throw new McpToolInputError('cursor belongs to a different quest snapshot generation')
    }
  }

  const base = availableQuestResultMetadata(source, available, generation, staleReason)
  if (!available) {
    return {
      ...base,
      total: null,
      returned: 0,
      hasMore: false,
      nextCursor: null,
      summary: null,
      quests: [],
    }
  }

  const quests = (Array.isArray(source.quests) ? source.quests : [])
    .map(normalizeAvailableQuestOutput)
    .filter((quest) => availableQuestMatches(quest, validated.filters))
    .sort((left, right) => left.questId - right.questId)
  const afterQuestId = cursorPayload ? cursorPayload.lastQuestId : null
  const remaining = afterQuestId == null
    ? quests
    : quests.filter((quest) => quest.questId > afterQuestId)
  const page = validated.limit === 0
    ? []
    : remaining.slice(0, validated.limit)
  const hasMore = validated.limit > 0 && remaining.length > page.length
  const nextCursor = hasMore && page.length > 0
    ? encodeAvailableQuestCursor(
      sessionId,
      generation,
      validated.filterHash,
      page[page.length - 1].questId,
    )
    : null

  return {
    ...base,
    total: quests.length,
    returned: page.length,
    hasMore,
    nextCursor,
    summary: validated.summary ? summarizeAvailableQuests(quests) : null,
    quests: page,
  }
}

function validateAvailableQuestsArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set([
    'questId', 'questIds', 'state', 'states', 'type', 'types',
    'category', 'categories', 'invalidFlag', 'invalidFlags',
    'limit', 'cursor', 'summary',
  ]))
  const summary = optionalBoolean(args.summary, 'summary') || false
  let limit
  if (args.limit == null) {
    limit = summary ? 0 : DEFAULT_AVAILABLE_QUESTS_LIMIT
  } else {
    limit = optionalInteger(args.limit, 'limit', 0)
    if (limit > MAX_AVAILABLE_QUESTS_LIMIT) {
      throw new McpToolInputError(
        `limit must be an integer from 0 to ${MAX_AVAILABLE_QUESTS_LIMIT}`,
      )
    }
  }
  if (!summary && limit === 0) {
    throw new McpToolInputError('limit:0 requires summary:true')
  }
  if (
    args.cursor != null &&
    (typeof args.cursor !== 'string' || args.cursor.length < 1 || args.cursor.length > 512)
  ) {
    throw new McpToolInputError('cursor must be a string from 1 to 512 characters')
  }

  const filters = {
    questIds: combinedIntegerSelectorsWithMinimum(
      args.questId,
      args.questIds,
      'questId',
      'questIds',
      1,
    ),
    states: combinedIntegerSelectorsWithMinimum(
      args.state,
      args.states,
      'state',
      'states',
      1,
      new Set([1, 2, 3]),
    ),
    types: combinedIntegerSelectorsWithMinimum(
      args.type,
      args.types,
      'type',
      'types',
      0,
    ),
    categories: combinedIntegerSelectorsWithMinimum(
      args.category,
      args.categories,
      'category',
      'categories',
      0,
    ),
    invalidFlags: combinedIntegerSelectorsWithMinimum(
      args.invalidFlag,
      args.invalidFlags,
      'invalidFlag',
      'invalidFlags',
      0,
    ),
  }
  return {
    summary,
    limit,
    filters,
    filterHash: hashFilters(filters),
  }
}

function combinedIntegerSelectorsWithMinimum(
  singular,
  plural,
  singularName,
  pluralName,
  minimum,
  allowed = null,
) {
  const values = []
  const single = optionalInteger(singular, singularName, minimum)
  if (single != null) values.push(single)
  if (plural != null) {
    if (!Array.isArray(plural)) {
      throw new McpToolInputError(`${pluralName} must be an array of integers`)
    }
    for (const value of plural) {
      const normalized = optionalInteger(value, pluralName, minimum)
      if (normalized == null) {
        throw new McpToolInputError(`${pluralName} must contain only integers`)
      }
      values.push(normalized)
    }
  }
  if (allowed && values.some((value) => !allowed.has(value))) {
    throw new McpToolInputError(`${pluralName} contains an unsupported value`)
  }
  return values.length === 0
    ? null
    : [...new Set(values)].sort((left, right) => left - right)
}

function availableQuestResultMetadata(source, available, generation, staleReason) {
  const quests = Array.isArray(source.quests) ? source.quests : []
  const snapshotTotal = Number.isSafeInteger(source.snapshotTotal) &&
    source.snapshotTotal >= 0
    ? source.snapshotTotal
    : quests.length
  return {
    available,
    complete: source.complete === true,
    stale: source.stale === true,
    staleReason,
    refreshHint: available ? null : AVAILABLE_QUESTS_REFRESH_HINT,
    source: typeof source.source === 'string'
      ? source.source
      : '/kcsapi/api_get_member/questlist',
    sourceTabId: 0,
    sessionId: typeof source.sessionId === 'string' ? source.sessionId : null,
    generation,
    capturedAt: typeof source.capturedAt === 'string' ? source.capturedAt : null,
    expiresAt: typeof source.expiresAt === 'string' ? source.expiresAt : null,
    invalidatedAt: typeof source.invalidatedAt === 'string'
      ? source.invalidatedAt
      : null,
    snapshotTotal,
    execCount: nullableNonNegativeInteger(source.execCount),
    execType: nullableNonNegativeInteger(source.execType),
    completedKind: nullableNonNegativeInteger(source.completedKind),
  }
}

function normalizeAvailableQuestOutput(quest) {
  if (
    !quest ||
    typeof quest !== 'object' ||
    Array.isArray(quest) ||
    !Number.isSafeInteger(quest.api_no) ||
    quest.api_no <= 0
  ) {
    throw new Error('Available quest snapshot contains an invalid quest entry')
  }
  const state = nullableInteger(quest.api_state)
  return {
    questId: quest.api_no,
    listIndex: nullableNonNegativeInteger(quest.listIndex),
    category: nullableInteger(quest.api_category),
    type: nullableInteger(quest.api_type),
    labelType: nullableInteger(quest.api_label_type),
    state,
    stateName: availableQuestStateName(state),
    title: typeof quest.api_title === 'string' ? quest.api_title : '',
    detail: typeof quest.api_detail === 'string' ? quest.api_detail : '',
    voiceId: nullableInteger(quest.api_voice_id),
    getMaterial: cloneJsonArrayValue(quest.api_get_material),
    bonusFlag: nullableInteger(quest.api_bonus_flag),
    progressFlag: nullableInteger(quest.api_progress_flag),
    invalidFlag: nullableInteger(quest.api_invalid_flag),
  }
}

function availableQuestMatches(quest, filters) {
  return (
    (filters.questIds == null || filters.questIds.includes(quest.questId)) &&
    (filters.states == null || filters.states.includes(quest.state)) &&
    (filters.types == null || filters.types.includes(quest.type)) &&
    (filters.categories == null || filters.categories.includes(quest.category)) &&
    (filters.invalidFlags == null || filters.invalidFlags.includes(quest.invalidFlag))
  )
}

function summarizeAvailableQuests(quests) {
  return {
    total: quests.length,
    unselectedCount: quests.filter((quest) => quest.state === 1).length,
    inProgressCount: quests.filter((quest) => quest.state === 2).length,
    completedCount: quests.filter((quest) => quest.state === 3).length,
    byState: countAvailableQuestValues(quests, 'state', 'state'),
    byType: countAvailableQuestValues(quests, 'type', 'type'),
    byCategory: countAvailableQuestValues(quests, 'category', 'category'),
    byInvalidFlag: countAvailableQuestValues(
      quests,
      'invalidFlag',
      'invalidFlag',
    ),
  }
}

function countAvailableQuestValues(quests, sourceKey, outputKey) {
  const counts = new Map()
  for (const quest of quests) {
    const value = quest[sourceKey]
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => {
      if (left == null) return right == null ? 0 : 1
      if (right == null) return -1
      return left - right
    })
    .map(([value, count]) => ({
      [outputKey]: value,
      ...(sourceKey === 'state' ? { stateName: availableQuestStateName(value) } : {}),
      count,
    }))
}

function availableQuestStateName(state) {
  if (state === 1) return 'unselected'
  if (state === 2) return 'in_progress'
  if (state === 3) return 'completed'
  return null
}

function encodeAvailableQuestCursor(
  sessionId,
  snapshotGeneration,
  filterHash,
  lastQuestId,
) {
  return Buffer.from(JSON.stringify({
    version: CURSOR_VERSION,
    toolName: 'get_available_quests',
    sessionId,
    snapshotGeneration,
    lastQuestId,
    normalizedFilterHash: filterHash,
  }), 'utf8').toString('base64url')
}

function decodeAvailableQuestCursor(cursor, expectedFilterHash) {
  if (
    typeof cursor !== 'string' ||
    cursor.length < 1 ||
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
      'lastQuestId,normalizedFilterHash,sessionId,snapshotGeneration,toolName,version'
  ) {
    throw new McpToolInputError('cursor has an invalid structure')
  }
  if (payload.version !== CURSOR_VERSION) {
    throw new McpToolInputError('cursor version is not supported')
  }
  if (payload.toolName !== 'get_available_quests') {
    throw new McpToolInputError('cursor belongs to a different tool')
  }
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length < 1) {
    throw new McpToolInputError('cursor sessionId is invalid')
  }
  if (!Number.isSafeInteger(payload.snapshotGeneration) || payload.snapshotGeneration < 0) {
    throw new McpToolInputError('cursor snapshotGeneration is invalid')
  }
  if (!Number.isSafeInteger(payload.lastQuestId) || payload.lastQuestId <= 0) {
    throw new McpToolInputError('cursor lastQuestId is invalid')
  }
  if (
    typeof payload.normalizedFilterHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.normalizedFilterHash) ||
    payload.normalizedFilterHash !== expectedFilterHash
  ) {
    throw new McpToolInputError('cursor filters do not match this search')
  }
  return payload
}

function nullableInteger(value) {
  return Number.isSafeInteger(value) ? value : null
}

function nullableNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function cloneJsonArrayValue(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (item == null || typeof item !== 'object') return item
    return JSON.parse(JSON.stringify(item))
  })
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

function positiveIntegerArraySchema() {
  return {
    type: 'array',
    items: { type: 'integer', minimum: 1 },
    uniqueItems: true,
  }
}

function nonNegativeIntegerArraySchema() {
  return {
    type: 'array',
    items: { type: 'integer', minimum: 0 },
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

function validateActionEventsArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set(['after', 'sessionId', 'limit']))
  return {
    after: boundedSafeInteger(args.after, 'after', 0, Number.MAX_SAFE_INTEGER, 0),
    sessionId: optionalSessionId(args.sessionId),
    limit: boundedSafeInteger(
      args.limit,
      'limit',
      1,
      MAX_ACTION_EVENTS_LIMIT,
      DEFAULT_ACTION_EVENTS_LIMIT,
    ),
  }
}

function formatActionEvents(args, raw) {
  const input = validateActionEventsArgs(args)
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const latestGeneration = generationValue(source.latestGeneration)
  const retained = Array.isArray(source.events)
    ? [...source.events].sort(compareGeneration)
    : []
  const earliestGeneration = generationValue(
    source.earliestGeneration == null
      ? (retained[0] && retained[0].generation)
      : source.earliestGeneration,
  )
  const hasMore = retained.length > input.limit
  const events = retained.slice(0, input.limit)
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId : null
  const sessionChanged = input.sessionId != null && input.sessionId !== sessionId
  return {
    available: source.available === true,
    sessionId,
    earliestGeneration,
    latestGeneration,
    requestedAfter: input.after,
    returned: events.length,
    hasMore,
    nextAfter: nextAfterValue(input.after, latestGeneration, hasMore, events),
    sessionChanged,
    cursorLost: cursorWasLost(
      input.after,
      earliestGeneration,
      latestGeneration,
      sessionChanged,
    ),
    events,
  }
}

function validateKcsapiResponsesArgs(args) {
  assertPlainObject(args)
  rejectUnknownProperties(args, new Set(['apiPath', 'after', 'sessionId', 'limit']))
  if (
    typeof args.apiPath !== 'string' ||
    args.apiPath.length < 9 ||
    args.apiPath.length > 512 ||
    !/^\/kcsapi\/[A-Za-z0-9_/-]+$/u.test(args.apiPath)
  ) {
    throw new McpToolInputError(
      'apiPath must be an exact /kcsapi/ path without query, fragment, wildcard, or regex syntax',
    )
  }
  return {
    apiPath: args.apiPath,
    after: boundedSafeInteger(args.after, 'after', 0, Number.MAX_SAFE_INTEGER, 0),
    sessionId: optionalSessionId(args.sessionId),
    limit: boundedSafeInteger(
      args.limit,
      'limit',
      1,
      MAX_KCSAPI_RESPONSES_LIMIT,
      DEFAULT_KCSAPI_RESPONSES_LIMIT,
    ),
  }
}

function formatKcsapiResponses(args, raw) {
  const input = validateKcsapiResponsesArgs(args)
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const latestGeneration = generationValue(source.latestGeneration)
  const earliestGeneration = generationValue(source.earliestGeneration)
  const retained = Array.isArray(source.responses)
    ? [...source.responses].sort(compareGeneration)
    : []
  const hasMore = retained.length > input.limit
  const page = retained.slice(0, input.limit)
  const candidates = []
  const responses = page.map((response, index) => {
    const entry = response && typeof response === 'object' && !Array.isArray(response)
      ? response
      : {}
    const storageTruncated = entry.truncated === true
    const responseBody = Object.prototype.hasOwnProperty.call(entry, 'responseBody')
      ? entry.responseBody
      : null
    const bodyBytes = storageTruncated ? null : serializedBytes(responseBody)
    const exceedsBodyLimit = !storageTruncated && bodyBytes > MAX_MCP_RESPONSE_BODY_BYTES
    const isCandidate = !storageTruncated && !exceedsBodyLimit && responseBody !== null
    if (isCandidate) {
      candidates.push({ index, responseBody })
    }
    return {
      generation: generationValue(entry.generation),
      capturedAt: typeof entry.capturedAt === 'string' ? entry.capturedAt : null,
      path: typeof entry.path === 'string' ? entry.path : input.apiPath,
      apiResult: Number.isInteger(entry.apiResult) ? entry.apiResult : null,
      responseBody: exceedsBodyLimit || isCandidate ? null : responseBody,
      storageTruncated,
      bodyOmitted: exceedsBodyLimit || isCandidate,
      bodyBytes,
    }
  })
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId : null
  const sessionChanged = input.sessionId != null && input.sessionId !== sessionId
  const result = {
    available: source.available === true,
    sessionId,
    apiPath: input.apiPath,
    earliestGeneration,
    latestGeneration,
    requestedAfter: input.after,
    returned: responses.length,
    hasMore,
    nextAfter: nextAfterValue(input.after, latestGeneration, hasMore, responses),
    sessionChanged,
    cursorLost: cursorWasLost(
      input.after,
      earliestGeneration,
      latestGeneration,
      sessionChanged,
    ),
    bodyOmittedCount: responses.filter((response) => response.bodyOmitted).length,
    responsePolicy: {
      postBodyIncluded: false,
      maxResponseBodyBytes: MAX_MCP_RESPONSE_BODY_BYTES,
      maxToolResultBytes: MAX_MCP_TOOL_RESULT_BYTES,
    },
    responses,
  }

  for (const candidate of candidates) {
    const response = responses[candidate.index]
    response.responseBody = candidate.responseBody
    response.bodyOmitted = false
    result.bodyOmittedCount = responses.filter((item) => item.bodyOmitted).length
    if (serializedBytes(result, true) > MAX_MCP_TOOL_RESULT_BYTES) {
      response.responseBody = null
      response.bodyOmitted = true
      result.bodyOmittedCount += 1
    }
  }
  return result
}

function boundedSafeInteger(value, name, minimum, maximum, fallback) {
  if (value == null) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new McpToolInputError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    )
  }
  return value
}

function optionalSessionId(value) {
  if (value == null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new McpToolInputError('sessionId must be a string from 1 to 128 characters')
  }
  return value
}

function generationValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function compareGeneration(left, right) {
  return generationValue(left && left.generation) - generationValue(right && right.generation)
}

function cursorWasLost(after, earliestGeneration, latestGeneration, sessionChanged) {
  return Boolean(
    sessionChanged ||
    after > latestGeneration ||
    (earliestGeneration > 0 && after < earliestGeneration - 1),
  )
}

function nextAfterValue(after, latestGeneration, hasMore, items) {
  if (hasMore && items.length > 0) {
    return generationValue(items[items.length - 1].generation)
  }
  return Math.max(after, latestGeneration)
}

function serializedBytes(value, pretty = false) {
  const serialized = JSON.stringify(value, null, pretty ? 2 : undefined)
  return Buffer.byteLength(serialized === undefined ? 'null' : serialized, 'utf8')
}

module.exports = {
  MCP_TOOL_DEFINITIONS,
  McpToolInputError,
  decodeCursor,
  decodePoiResources,
  encodeCursor,
  equipmentTypeId,
  formatActionEvents,
  formatAirbaseStatus,
  formatAvailableQuests,
  formatKcsapiResponses,
  formatQuests,
  formatResourceHistory,
  normalizeSearchText,
  searchEquipment,
  searchShips,
  validateEquipmentSearchArgs,
  validateActionEventsArgs,
  validateAvailableQuestsArgs,
  validateFleetStatusArgs,
  validateGetAllArgs,
  validateNoArguments,
  validateKcsapiResponsesArgs,
  validateResourceHistoryArgs,
  validateShipSearchArgs,
}
