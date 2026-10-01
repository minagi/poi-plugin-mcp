function createStoreFixture() {
  return {
    info: {
      basic: { api_level: 120, api_nickname: 'fixture-admiral' },
      fleets: [
        {
          api_id: 1,
          api_name: 'Fixture Fleet',
          api_mission: [0, 0, 0, 0],
          api_ship: [101, -1, -1, -1, -1, -1],
        },
      ],
      ships: {
        101: {
          api_id: 101,
          api_ship_id: 501,
          api_lv: 80,
          api_cond: 49,
          api_locked: 1,
          api_nowhp: 30,
          api_maxhp: 30,
          api_soku: 10,
          api_fuel: 15,
          api_bull: 20,
          api_slotnum: 1,
          api_slot: [201, -1, -1, -1, -1],
          api_slot_ex: 202,
          api_onslot: [0],
          api_sally_area: 2,
          api_karyoku: [20, 49],
          api_raisou: [30, 79],
          api_taiku: [20, 49],
          api_soukou: [15, 49],
          api_lucky: [10, 49],
          api_sakuteki: [12, 39],
          api_taisen: [20, 59],
        },
        102: {
          api_id: 102,
          api_ship_id: 502,
          api_lv: 20,
          api_cond: 30,
          api_locked: 0,
          api_nowhp: 15,
          api_maxhp: 15,
          api_soku: 10,
          api_fuel: 10,
          api_bull: 10,
          api_slotnum: 0,
          api_slot: [-1, -1, -1, -1, -1],
          api_slot_ex: 0,
          api_onslot: [],
          api_sally_area: 0,
        },
      },
      equips: {
        201: {
          api_id: 201,
          api_slotitem_id: 301,
          api_level: 6,
          api_alv: 0,
          api_locked: 1,
        },
        202: {
          api_id: 202,
          api_slotitem_id: 302,
          api_level: 0,
          api_alv: 7,
          api_locked: 0,
        },
        203: {
          api_id: 203,
          api_slotitem_id: 301,
          api_level: 0,
          api_alv: 0,
          api_locked: 0,
        },
      },
      resources: [1000, 2000, 3000, 4000, 5, 6, 7, 8],
      quests: {
        activeQuests: { 101: { api_no: 101, api_state: 2 } },
        records: { 101: { current: 3, total: 5 } },
      },
      airbase: [{ api_area_id: 6, api_rid: 1, unknownFixtureField: 'kept' }],
      repairs: [{ api_id: 1 }],
      constructions: [{ api_id: 1 }],
      maps: { 61: { api_id: 61 } },
      useitems: { 1: { api_id: 1, api_count: 9 } },
    },
    sortie: { active: false },
    const: {
      $ships: {
        501: { api_id: 501, api_name: 'Fixture Destroyer', api_stype: 2, api_soku: 10 },
        502: { api_id: 502, api_name: 'Fixture Escort', api_stype: 2, api_soku: 10 },
      },
      $shipTypes: {
        2: { api_id: 2, api_name: 'Destroyer' },
      },
      $equips: {
        301: { api_id: 301, api_name: 'Fixture Gun', api_type: [1, 1, 1], api_sortno: 1 },
        302: { api_id: 302, api_name: 'Fixture Fighter', api_type: [6, 6, 6], api_sortno: 2 },
      },
      $equipTypes: {
        1: { api_id: 1, api_name: 'Small Gun' },
        6: { api_id: 6, api_name: 'Fighter' },
      },
      $missions: {},
    },
  }
}

function createQuestFixture(questId, overrides = {}) {
  return {
    api_no: questId,
    api_category: (questId % 11) + 1,
    api_type: (questId % 5) + 1,
    api_label_type: 0,
    api_state: questId % 20 === 0 ? 3 : (questId % 10 === 0 ? 2 : 1),
    api_title: `Synthetic Quest ${questId}`,
    api_detail: `Synthetic quest detail ${questId}`,
    api_voice_id: 0,
    api_get_material: [questId % 5, 0, 0, 0],
    api_bonus_flag: 0,
    api_progress_flag: questId % 3,
    api_invalid_flag: questId % 17 === 0 ? 1 : 0,
    ...overrides,
  }
}

function createQuestListDetail(options = {}) {
  const tabId = options.tabId == null ? 0 : options.tabId
  const quests = options.quests || Array.from(
    { length: options.count == null ? 80 : options.count },
    (_, index) => createQuestFixture(index + 1),
  )
  return {
    path: '/kcsapi/api_get_member/questlist',
    apiResult: options.apiResult == null ? 1 : options.apiResult,
    postBody: {
      api_verno: '1',
      api_tab_id: String(tabId),
    },
    body: {
      api_count: options.apiCount == null ? quests.length : options.apiCount,
      api_completed_kind: options.completedKind == null ? 0 : options.completedKind,
      api_list: quests,
      api_exec_count: options.execCount == null ? 6 : options.execCount,
      api_exec_type: options.execType == null ? 123456 : options.execType,
    },
  }
}

function createAvailableQuestSnapshotFixture(overrides = {}) {
  const {
    count = 80,
    quests: overriddenQuests,
    ...snapshotOverrides
  } = overrides
  const quests = overriddenQuests || Array.from(
    { length: count },
    (_, index) => ({ ...createQuestFixture(index + 1), listIndex: index }),
  )
  return {
    sessionId: 'fixture-quest-session',
    generation: 1,
    available: true,
    complete: true,
    stale: false,
    staleReason: null,
    capturedAt: '2026-09-30T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    invalidatedAt: null,
    source: '/kcsapi/api_get_member/questlist',
    sourceTabId: 0,
    apiCount: quests.length,
    execCount: 6,
    execType: 123456,
    completedKind: 0,
    snapshotTotal: quests.length,
    quests,
    ...snapshotOverrides,
  }
}

module.exports = {
  createAvailableQuestSnapshotFixture,
  createQuestFixture,
  createQuestListDetail,
  createStoreFixture,
}
