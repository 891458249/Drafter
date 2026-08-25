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
  packageIndex = map
  return map
}

// pnpm 第三方包索引:包名 → 入口文件绝对路径(从 vendor-deps/<name>/ 解析,
// vendor-deps 是打包前从 .pnpm 复制出来的非隐藏目录,避免 electron-builder 排除 dotdir)。
function buildPnpmIndex(root) {
  if (pnpmIndex) return pnpmIndex
  const map = new Map()
  const depsDir = path.join(root, 'vendor-deps')
  if (!existsSync(depsDir)) { pnpmIndex = map; return map }
  const scan = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name.startsWith('@')) {
        // 作用域包:再下一层
        scanScope(map, p, e.name)
      } else {
        registerPnpmPackage(map, e.name, p)
      }
    }
  }
  scan(depsDir)
  pnpmIndex = map
  return map
}

function scanScope(map, scopeDir, scopeName) {
  let entries
  try { entries = readdirSync(scopeDir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    registerPnpmPackage(map, scopeName + '/' + e.name, path.join(scopeDir, e.name))
  }
}

function registerPnpmPackage(map, name, pkgPath) {
  const pj = path.join(pkgPath, 'package.json')
  if (!existsSync(pj)) return
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
  // @deepseek-ai/* 走 harness 包索引
  if (specifier.startsWith('@deepseek-ai/')) {
    const index = buildIndex(root)
    const hit = index.get(specifier)
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
  } else {
    // 第三方包走 pnpm 索引(仅当默认解析失败时才兜底——开发态 node_modules 已能解析,
    // 打包态 asar 里没有这些包)
    try {
      return await nextResolve(specifier, context)
    } catch {
      const pindex = buildPnpmIndex(root)
      const hit = pindex.get(specifier)
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
      throw new Error(`cannot resolve ${specifier}`)
    }
  }
  return nextResolve(specifier, context)
}

