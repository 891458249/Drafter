// Drafter harness ESM 解析 hook(打包态/开发态通用):
// 把所有 @deepseek-ai/* 裸包名解析到 vendor/deepseek-harness 的物理路径
// (packages/<group>/<pkg>/lib/index.js 或 vendor/<pkg>/lib/index.js);
// 第三方包(zod/fflate/...)解析到 vendor/deepseek-harness/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/。
//
// 经 Node 的 module.register() 注册为全局 ESM resolve hook,在 harness-bridge
// 的任何动态 import 之前装上。

import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

let packageIndex = null
let pnpmIndex = null

// @deepseek-ai/* 包索引:包名 → lib/index.js 绝对路径
function buildIndex(root) {
  if (packageIndex) return packageIndex
  const map = new Map()
  const scan = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      const pj = path.join(p, 'package.json')
      if (existsSync(pj)) {
        try {
          const m = JSON.parse(readFileSync(pj, 'utf8'))
          if (m.name && m.name.startsWith('@deepseek-ai/')) {
            const main = m.main || 'lib/index.js'
            const mp = path.join(p, main)
            if (existsSync(mp)) map.set(m.name, mp)
            else {
              const fb = path.join(p, 'lib', 'index.js')
              if (existsSync(fb)) map.set(m.name, fb)
            }
          }
        } catch { /* 忽略坏 manifest */ }
      }
      scan(p, depth + 1)
    }
  }
  scan(path.join(root, 'packages'), 0)
  scan(path.join(root, 'vendor'), 0)
  // native/ 下的 workspace 包(landlock-run 等)也在依赖闭包里
  scan(path.join(root, 'native'), 0)
  packageIndex = map
  return map
}

// pnpm 第三方包索引:包名 → 入口文件绝对路径(从 vendor-deps/<name>/ 解析,
// vendor-deps 是打包前从 .pnpm 复制出来的非隐藏目录,避免 electron-builder 排除 dotdir)。
// dirs 索引(包名 → 包目录)与入口索引并列:像 @babel/runtime 这种无根入口、
// 纯子路径导出的包,入口索引收不到,但子路径解析要以包目录为基(v0.11.13)。
function buildPnpmIndex(root) {
  if (pnpmIndex) return pnpmIndex
  const map = new Map()
  const dirs = new Map()
  const depsDir = path.join(root, 'vendor-deps')
  if (!existsSync(depsDir)) { pnpmIndex = { map, dirs }; return pnpmIndex }
  const scan = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name.startsWith('@')) {
        // 作用域包:再下一层
        scanScope(map, dirs, p, e.name)
      } else {
        registerPnpmPackage(map, dirs, e.name, p)
      }
    }
  }
  scan(depsDir)
  pnpmIndex = { map, dirs }
  return pnpmIndex
}

function scanScope(map, dirs, scopeDir, scopeName) {
  let entries
  try { entries = readdirSync(scopeDir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    registerPnpmPackage(map, dirs, scopeName + '/' + e.name, path.join(scopeDir, e.name))
  }
}

function registerPnpmPackage(map, dirs, name, pkgPath) {
  const pj = path.join(pkgPath, 'package.json')
  if (!existsSync(pj)) return
  dirs.set(name, pkgPath)
  try {
    const m = JSON.parse(readFileSync(pj, 'utf8'))
    let entry = null
    // exports['.'] 可能是字符串、扁平对象({import,require,default})或嵌套对象
    // ({node:{import:{default}}})。递归找叶子,**优先 node 条件**(这是 Node 主进程),
    // 再 import > default > require;browser 放最后(它通常缺 node API)。
    const findEntry = (obj) => {
      if (typeof obj === 'string') return obj
      if (!obj || typeof obj !== 'object') return null
      for (const key of ['node', 'import', 'default', 'require', 'browser']) {
        if (obj[key] !== undefined) {
          const found = findEntry(obj[key])
          if (found) return found
        }
      }
      return null
    }
    if (m.exports) {
      if (m.exports['.']) entry = findEntry(m.exports['.'])
      else entry = findEntry(m.exports)
    }
    if (!entry) entry = m.main || m.module || 'index.js'
    const mp = path.join(pkgPath, entry)
    if (existsSync(mp)) map.set(name, mp)
  } catch {}
}

export async function resolve(specifier, context, nextResolve) {
  const root = process.env.__DRAFTER_HARNESS_ROOT__
  if (!root) return nextResolve(specifier, context)
  // 先拆子路径:'@scope/name/sub/path' → 包名 '@scope/name' + 子路径 'sub/path'
  let pkgName = specifier
  let subPath = ''
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    pkgName = parts.slice(0, 2).join('/')
    subPath = parts.slice(2).join('/')
  } else {
    const parts = specifier.split('/')
    pkgName = parts[0]
    subPath = parts.slice(1).join('/')
  }
  // @deepseek-ai/* 走 harness 包索引
  if (pkgName.startsWith('@deepseek-ai/')) {
    const index = buildIndex(root)
    const hit = index.get(pkgName)
    if (hit) {
      // 子路径:先读 package.json 的 exports 映射('./api' → './lib/types/api/index.js'),
      // 没有再走「拼到包目录下」的兜底。
      if (subPath) {
        const pkgDir = path.dirname(path.dirname(hit)) // lib/index.js → 包根
        const pjPath = path.join(pkgDir, 'package.json')
        if (existsSync(pjPath)) {
          try {
            const m = JSON.parse(readFileSync(pjPath, 'utf8'))
            const exp = m.exports && m.exports['./' + subPath]
            if (exp) {
              const entry = typeof exp === 'string' ? exp : (exp.default || exp.import || exp.require)
              if (entry) {
                const mp = path.join(pkgDir, entry)
                if (existsSync(mp)) return { url: pathToFileURL(mp).href, shortCircuit: true }
              }
            }
          } catch {}
        }
        // 兜底:直接拼
        const subFile = path.join(pkgDir, subPath)
        for (const cand of [subFile, subFile + '.js', subFile + '/index.js', subFile + '.mjs']) {
          if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true }
        }
      }
      return { url: pathToFileURL(hit).href, shortCircuit: true }
    }
  } else {
    // 第三方包:vendor-deps 索引优先(它才是权威;nextResolve 在打包态可能误中
    // Drafter 自己的 node_modules 或 harness 的 .pnpm 残留)。
    const { map: pindex, dirs: pdirs } = buildPnpmIndex(root)
    const hit = pindex.get(pkgName)
    const pkgDirFromDirs = pdirs.get(pkgName)
    if (hit || (subPath && pkgDirFromDirs)) {
      if (subPath) {
        // 先读 package.json exports 的子路径映射(支持 './api/*' 通配符)
        const pkgDir = hit ? path.dirname(path.dirname(hit)) : pkgDirFromDirs
        const pjPath = path.join(pkgDir, 'package.json')
        if (existsSync(pjPath)) {
          try {
            const m = JSON.parse(readFileSync(pjPath, 'utf8'))
            if (m.exports) {
              // 精确匹配 './compile'
              const exact = m.exports['./' + subPath]
              if (exact) {
                const entry = typeof exact === 'string' ? exact : (exact.default || exact.import || exact.require)
                if (entry) {
                  const mp = path.join(pkgDir, entry)
                  if (existsSync(mp)) return { url: pathToFileURL(mp).href, shortCircuit: true }
                }
              }
              // 通配符匹配:'./api/*' → './dist/api/*.js',subPath 'anthropic-messages.lazy' → 填进 *
              for (const [pattern, target] of Object.entries(m.exports)) {
                if (!pattern.includes('*')) continue
                const prefix = pattern.slice(2, pattern.indexOf('*')) // './api/'
                if (!subPath.startsWith(prefix)) continue
                const suffix = subPath.slice(prefix.length) // 'anthropic-messages.lazy'
                const resolvedTarget = typeof target === 'string' ? target : (target.default || target.import || target.require)
                if (!resolvedTarget) continue
                const mp = path.join(pkgDir, resolvedTarget.replace('*', suffix))
                if (existsSync(mp)) return { url: pathToFileURL(mp).href, shortCircuit: true }
                // 再试加 .js
                if (existsSync(mp + '.js')) return { url: pathToFileURL(mp + '.js').href, shortCircuit: true }
              }
            }
          } catch {}
        }
        // 兜底:直接拼
        const subFile = path.join(pkgDir, subPath)
        for (const cand of [subFile, subFile + '.js', subFile + '/index.js', subFile + '.mjs', subFile + '.cjs']) {
          if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true }
        }
        return nextResolve(specifier, context)
      }
      return { url: pathToFileURL(hit).href, shortCircuit: true }
    }
    // 索引里没有,交回默认解析
    return nextResolve(specifier, context)
  }
  return nextResolve(specifier, context)
}

