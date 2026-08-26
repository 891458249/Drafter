// 插件启停(v0.11.8):harness 设置→插件列表的「启用/停用」开关的宿主半。
//
// 背景:harness 官方的 pluginInventory 是只读投影(上游设计如此,启停靠手改
// profile 的 cordis.patch.yml 用户补丁层)。而 Drafter 的合成树直接用内存里的
// bundle patches + drafterOverlay,用户连可编辑的补丁层文件都没有——启停彻底无解。
//
// 本模块补齐这条链路:
//  1. PluginControlService:SRC 模式的 Typert Remote 服务(无生成 descriptor,
//     gateway 从 typertRemote binding + Remote 标记 + 函数签名生成弱 descriptor),
//     暴露 pluginControl/setEnabled,经已桥接的 /api 复合通道即可调用。
//  2. 持久化:启用状态写进 $DSH_HOME/profiles/web/cordis.patch.yml(官方用户补丁层
//     位置与格式,boot 时作为最后/最高优先级补丁层应用,见 harness-bridge.js)。
//     本文件只由本模块写入(纯 {id, disabled} 行,无 !!js),读回用普通 YAML schema。
//
// plain JS 没有 decorator 语法:Remote('setEnabled') 返回的装饰器手动调用——
// 它的 addInitializer 回调本应在实例构造时以 this=实例 执行,把标记写进
// typert-protocol 的 WeakMap(键为 prototype);这里立即以「prototype 为类原型」的
// 对象执行,效果等价。gateway 的 remoteMethods(original) 读的就是这张表。

const path = require('node:path')
const fs = require('node:fs')

// —— 持久化:用户补丁层文件 ————————————————————————————————————————————————————

// 补丁层里的根载体行 id:运行态条目 id 为 'include'(无树路径前缀)的 cordis:include
// 根条目承载整棵插件树——停用它会在运行态拆掉所有插件(apiproxy 随之 dispose,
// /api 全 404;v0.11.8 用户实测踩中)。boot 时该行虽不生效(根 include 的数据行
// 不参与补丁匹配),但留在文件里会造成「文件说停用、实际启用」的状态漂移,
// 读取时直接剔除并回写修复。
const CARRIER_ROW_IDS = new Set(['include'])

function togglesFile(profileDir) {
  return path.join(profileDir, 'cordis.patch.yml')
}

// 读取用户补丁层(不存在返回 []),并剔除根载体行(有剔除则回写修复文件)。
// yamlLib 是 vendor 的 js-yaml(ESM,动态 import 传入)。
async function loadUserPatches(profileDir, yamlLib, log) {
  const file = togglesFile(profileDir)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const parsed = yamlLib.load(text)
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed)) throw new Error(`插件启停补丁层格式错误(应为数组): ${file}`)
  const rows = parsed.filter((row) => !(row && typeof row.id === 'string' && CARRIER_ROW_IDS.has(row.id)))
  if (rows.length !== parsed.length) {
    if (log) log(`用户补丁层剔除了 ${parsed.length - rows.length} 条根载体行(include),回写修复`)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, '# Drafter 插件启停补丁层(由设置→插件列表的开关维护,勿手改)\n' + yamlLib.dump(rows), 'utf8')
    fs.renameSync(tmp, file)
  }
  return rows
}

// upsert 一条 { id, disabled } 并写回(先读合再写,保留其他行)。
async function saveUserPatch(profileDir, yamlLib, id, disabled) {
  const rows = await loadUserPatches(profileDir, yamlLib)
  const index = rows.findIndex((row) => row && row.id === id && !row.insert)
  const row = { id, disabled }
  if (index === -1) rows.push(row)
  else rows[index] = row
  const file = togglesFile(profileDir)
  // 原子写:先写临时文件再改名,防止中途断电留下半个 YAML
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, '# Drafter 插件启停补丁层(由设置→插件列表的开关维护,勿手改)\n' + yamlLib.dump(rows), 'utf8')
  fs.renameSync(tmp, file)
}

// —— SRC Remote 服务 ———————————————————————————————————————————————————————————

// 手动应用 @Remote(exportName) 装饰器(见文件头说明)。重复应用同一标记静默幂等。
function applyRemoteDecorator(Remote, proto, methodName, exportName) {
  Remote(exportName)(proto[methodName], {
    name: methodName,
    private: false,
    static: false,
    addInitializer(fn) {
      fn.call(Object.create(proto))
    },
  })
}

// 挂载 pluginControl 服务。typertProtocol 是 vendor 的 @deepseek-ai/dsh-typert-protocol
// (ESM,由 harness-bridge 动态 import 后传入);profileDir 是 $DSH_HOME/profiles/web。
async function mountPluginControl(ctx, typertProtocol, yamlLib, profileDir, log) {
  const { Remote, TypertRemoteService } = typertProtocol

  class PluginControlService extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'pluginControl')
    }

    // SRC 弱 descriptor 按函数签名顺序取参数名:entryId/enabled 即 wire 字段名。
    // 注意保持参数名不变(gateway 从源码解析),不要加默认值/解构。
    async setEnabled(entryId, enabled) {
      const loader = this.ctx.get('loader')
      if (!loader) throw new Error('loader service unavailable')
      // 运行态条目 id 形如 include:<rowId>(树路径前缀),loader.store 只键顶层条目,
      // 必须遍历 entries() 匹配;补丁层按 YAML 行 id(options.id,无前缀)定位。
      const entry = [...loader.entries()].find((e) => e.id === entryId)
      if (!entry) throw new Error(`unknown plugin entry: ${entryId}`)
      // 根载体/插件组不可开关:停用 include 根会在运行态拆掉整棵插件树
      // (apiproxy 随之 dispose,/api 全 404;v0.11.8 实测踩中)
      if (entry.options && entry.options.group) throw new Error(`插件组不支持单独启停: ${entryId}`)
      const moduleName = entry.options && entry.options.name
      if (moduleName === 'cordis:include' || !String(entry.id).includes(':')) {
        throw new Error('根插件载体(include)承载整棵插件树,不能停用')
      }
      const rowId = entry.options && entry.options.id
      if (!rowId) throw new Error(`plugin entry ${entryId} 没有稳定的行 id,无法持久化启停`)
      await entry.update({ disabled: !enabled })
      // 运行态切换成功后才持久化;持久化失败运行态不回滚(下次 boot 以文件为准,
      // 这里抛出让调用方知道落盘没成)
      await saveUserPatch(profileDir, yamlLib, rowId, !enabled)
      return { entryId, enabled: !entry.disabled }
    }
  }

  applyRemoteDecorator(Remote, PluginControlService.prototype, 'setEnabled', 'setEnabled')

  ctx.plugin(PluginControlService)
  log('pluginControl service mounted (SRC Remote: pluginControl/setEnabled)')
}

module.exports = { loadUserPatches, mountPluginControl, togglesFile }
