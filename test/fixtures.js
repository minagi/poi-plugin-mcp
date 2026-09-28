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

module.exports = { createStoreFixture }
