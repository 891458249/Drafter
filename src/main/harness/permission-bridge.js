// Drafter 权限模式 → harness 权限预设/沙箱/审批策略映射(Phase 3)。
//
// Drafter 侧 5 种模式(meta.permissionMode):default / acceptEdits / plan / dontAsk / bypassPermissions。
// harness 侧两个独立旋钮(permission-presets 包):
//   sandbox mode:  'read-only' | 'workspace-write' | 'danger-full-access'
//   approval policy: 'ask' | 'never'
// 另有 plan 模式是独立协作状态(ctx.planMode),不与权限预设捆绑。
//
// 映射表(harness 预设名 → { sandbox, approval, plan }):
//   default           → workspace-write + ask      (常规工作区写入,编辑需审批)
//   acceptEdits       → workspace-write + never    (工作区写入免审批)
//   plan              → read-only + ask + planMode (计划模式:只读 + 审批 + 计划指引)
//   dontAsk           → workspace-write + never    (不打扰;同 acceptEdits 但语义不同,保留独立预设)
//   bypassPermissions → danger-full-access + never (完全放开)

const PRESET_TABLE = {
  'default': {
    sandbox: 'workspace-write', approval: 'ask',
    name: '默认', description: '工作区内可写,编辑与危险操作需逐个审批。',
  },
  'acceptEdits': {
    sandbox: 'workspace-write', approval: 'never',
    name: '接受编辑', description: '工作区内编辑自动通过,不再逐次询问。',
  },
  'plan': {
    sandbox: 'read-only', approval: 'ask',
    name: '计划模式', description: '只读探索 + 计划评审;不产生任何写操作。',
  },
  'dontAsk': {
    sandbox: 'workspace-write', approval: 'never',
    name: '免打扰', description: '工作区内操作一律不询问。',
  },
  'bypassPermissions': {
    sandbox: 'danger-full-access', approval: 'never',
    name: '完全放开', description: '不沙箱、不审批,等同裸奔。谨慎使用。',
  },
}

const DRAFTER_MODES = Object.keys(PRESET_TABLE)

/** Drafter 模式名 → harness 预设名(同名的直接可用,此层留出未来改名空间)。 */
function toHarnessPreset(drafterMode) {
  return DRAFTER_MODES.includes(drafterMode) ? drafterMode : 'default'
}

/** harness 预设名 → Drafter 模式名(读回时)。 */
function fromHarnessPreset(presetName) {
  return DRAFTER_MODES.includes(presetName) ? presetName : 'default'
}

/** 生成覆盖 harness 默认权限预设表的 patch config(替换成我们的 5 档)。 */
function permissionPresetsConfig() {
  return {
    presets: PRESET_TABLE,
    defaultPreset: 'default',
  }
}

/**
 * 切换一个会话的权限模式(写 harness 的 permission/preset 事件 + sandbox/approval knob)。
 * @param {object} harnessCtx - boot 后的 Cordis Context
 * @param {object|string} sessionOrId - harness 的 Session 对象或 sessionId
 * @param {string} drafterMode - Drafter 的 5 种模式之一
 */
async function setSessionPermissionMode(harnessCtx, sessionOrId, drafterMode) {
  const permissionPresets = harnessCtx.get('permissionPresets')
  if (!permissionPresets) throw new Error('harness 缺 permissionPresets 服务')
  const preset = toHarnessPreset(drafterMode)
  // session 对象需要从 sessions 服务取(若传的是 id)
  let session = sessionOrId
  if (typeof sessionOrId === 'string') {
    const sessions = harnessCtx.get('sessions')
    session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionOrId) : null
    if (!session) throw new Error(`session not found: ${sessionOrId}`)
  }
  permissionPresets.set(session, preset)
  return { preset, mode: drafterMode }
}

module.exports = {
  PRESET_TABLE,
  DRAFTER_MODES,
  toHarnessPreset,
  fromHarnessPreset,
  permissionPresetsConfig,
  setSessionPermissionMode,
}
