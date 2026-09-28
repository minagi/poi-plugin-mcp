const { createBridgeController } = require('./lib/bridge-controller')
const { createPoiTelemetry } = require('./lib/poi-telemetry')
const { createSettingsClass } = require('./lib/settings-view')

const telemetry = createPoiTelemetry()
const controller = createBridgeController({
  getQuestList: telemetry.getQuestList,
  getMissionBoard: telemetry.getMissionBoard,
  getQuestAction: telemetry.getQuestAction,
  getEquipmentAction: telemetry.getEquipmentAction,
  getEquipmentSelection: telemetry.getEquipmentSelection,
  getUnsetSlot: telemetry.getUnsetSlot,
  getFleetAction: telemetry.getFleetAction,
  getActionEvents: telemetry.getActionEvents,
  getActionEventsWait: telemetry.getActionEventsWait,
  getApiResponses: telemetry.getApiResponses,
  getBattleTelemetry: telemetry.getBattleTelemetry,
})
const settingsClass = createSettingsClass(controller)

function pluginDidLoad() {
  if (typeof window !== 'undefined') {
    window.addEventListener('game.response', telemetry.handleGameResponse)
  }
  controller.load().catch((error) => {
    console.error('[poi-plugin-mcp] Failed to start:', error.message)
  })
}

function pluginWillUnload() {
  if (typeof window !== 'undefined') {
    window.removeEventListener('game.response', telemetry.handleGameResponse)
  }
  controller.unload().catch((error) => {
    console.error('[poi-plugin-mcp] Failed to stop:', error.message)
  })
}

module.exports = {
  pluginDidLoad,
  pluginWillUnload,
  settingClass: settingsClass,
  settingsClass,
  _controller: controller,
}
