// Drafter Key 体系 → harness 模型/凭据对接(Phase 2)。
//
// Drafter 侧:store.settings.apiKeys = [{ id, name, key, baseUrl, kind, models, modelGroups }],
//   activeKeyId 指当前 Key;完整 key 不出主进程。
// harness 侧:provider 路由由 settings 命名空间 `llm-pi-ai.providers.<id>` 声明
//   (api/baseURL/models/apiKeyEnv),凭据存 $DSH_HOME/.credentials.yaml(经 ctx.credentials.set),
//   apiKeyEnv 是「凭据引用名」而非环境变量名。
//
// 映射策略:
//  - 每个 Drafter Key → 一个 harness 自定义 provider(id 用 key.id,稳定)
//    · Kuro 网关(baseUrl 含 /v1 或 Anthropic 兼容)→ api: 'anthropic-messages'(Kuro 兼容 Anthropic 协议)
//    · 其它 OpenAI 兼容 → api: 'openai-completions'
//  - key 的明文经 harness 的 credentials API 写入(引用名 = `drafter-key-<id>`)
//  - 模型列表:优先用 key.models(用户发现/勾选过),为空则给默认 anthropic 目录
//  - 激活:把 activeKeyId 对应的 provider/model 写进 agent-default-model 的默认选择

const path = require('node:path')
const store = require('../store')

// —— 纯函数:从 Drafter Key 生成 harness provider 路由条目 ————————————————————————

/** 判定一个 Drafter Key 的 wire 协议(给 harness 的 api 字段)。 */
function apiOf(key) {
  const url = (key.baseUrl || '').toLowerCase()
  // apiKey/authToken 表示 Anthropic Messages 兼容鉴权;不过 Kimi Coding 的
  // baseURL 已经是 /coding/v1,而 Anthropic SDK 会固定追加 /v1/messages,
  // 得到错误的 /coding/v1/v1/messages(404)。Kimi Coding 是 OpenAI
  // chat-completions 兼容端点,应走 pi-ai 的 openai-completions 路由。
  if (/api\.kimi\.com\/coding\/v1\/?$/.test(url)) return 'openai-completions'
  if (key.kind === 'apiKey' || /anthropic|kuro/.test(url) || key.kind === 'authToken') return 'anthropic-messages'
  return 'openai-completions'
}

/** 凭据引用名(harness 侧 .credentials.yaml 的键)。必须是 POSIX 环境变量格式
 *  (harness 的 credentialRef 要求 /^[A-Za-z_][A-Za-z0-9_]*$/),把 key.id 里的非法字符转下划线。 */
function credentialRefOf(keyId) {
  const safe = String(keyId).replace(/[^A-Za-z0-9_]/g, '_')
  return `DRAFTER_KEY_${safe}`.replace(/^([0-9])/, '_$1') // 不能以数字开头
}

/** 一个 Drafter Key → harness `llm-pi-ai.providers` 的一条路由配置。 */
function keyToProvider(key) {
  const api = apiOf(key)
  const models = Array.isArray(key.models) && key.models.length
    ? key.models.map((id) => ({ id }))
    : [{ id: 'claude-sonnet-4-5' }] // 目录兜底:让选择器至少有一项
  const provider = {
    displayName: key.name || key.id,
    apiKeyEnv: credentialRefOf(key.id),
    api,
    models,
  }
  if (key.baseUrl) provider.baseURL = key.baseUrl
  return provider
}

/** 由全部启用 Key 生成完整的 `llm-pi-ai` providers 节。 */
function buildProvidersSection(keys) {
  const providers = {}
  for (const k of keys) {
    if (k.enabled === false) continue
    providers[k.id] = keyToProvider(k)
  }
  return { providers }
}

// —— 应用侧:把 Drafter 的 Key 状态推进 harness 运行时 ————————————————————————————

/**
 * 把 Drafter 的全部启用 Key 同步进 harness 运行时(ctx.credentials + ctx.settings)。
 * 在 harness boot 后调用;之后 Key 变更时可重跑(幂等)。
 * @param {object} harnessCtx - boot 后的 Cordis Context(需有 credentials/settings 服务)
 */
async function syncKeysToHarness(harnessCtx) {
  const keys = (store.getSetting('apiKeys', []) || []).filter((k) => k.enabled !== false)
  const activeKeyId = store.getSetting('activeKeyId')

  const credentials = harnessCtx.get('credentials')
  const settings = harnessCtx.get('settings')
  if (!credentials || !settings) {
    throw new Error('harness 缺 credentials/settings 服务,boot 未完成?')
  }

  // 1) 写凭据(明文 key → harness 凭据引用)
  for (const k of keys) {
    if (!k.key) continue
    await credentials.set(credentialRefOf(k.id), k.key)
  }

  // 2) 写 provider 路由(settings.replace 覆盖 llm-pi-ai 命名空间,保证与 Drafter 一致)
  const section = buildProvidersSection(keys)
  await settings.replace('llm-pi-ai', section)

  // 3) 把活跃 Key 设为默认模型路由(agent-default-model)
  const active = keys.find((k) => k.id === activeKeyId) || keys[0]
  if (active) {
    const model = (Array.isArray(active.models) && active.models[0]) || 'claude-sonnet-4-5'
    const agentDefaultModel = harnessCtx.get('agentDefaultModel')
    if (agentDefaultModel && typeof agentDefaultModel.saveSelection === 'function') {
      await agentDefaultModel.saveSelection({ provider: active.id, model })
    }
  }

  return { providers: Object.keys(section.providers), activeProvider: active ? active.id : null }
}

module.exports = {
  apiOf,
  credentialRefOf,
  keyToProvider,
  buildProvidersSection,
  syncKeysToHarness,
}
