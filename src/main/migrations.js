// 数据迁移与自愈框架(v0.9.17)
// 解决「每次更新后旧会话多多少少出些问题」:版本升级后在启动时对所有存量
// 会话/设置统一做迭代修复,而不是等用户点开会话才在 start() 里 lazy 兜底
// (lazy 兜底意味着没点到的会话一直是坏的,且已「卡死」过的会话不会自己复活)。
//
// 两层机制:
//  1. repairs    —— 每次启动都跑的幂等自愈(便宜:每会话一次 existsSync),
//                  修「存量数据与当前代码假设不一致」的问题;
//  2. migrations —— 按版本号一次性执行的数据改写,游标存在 settings.dataVersion;
//                  今后任何破坏性的数据格式变更必须在这里登记一条。
//
// 铁律:只修不删。不删会话、不删事件日志、不删 transcript 文件;修不好就降级
// (如清掉 sdkSessionId 让会话以全新上下文启动,界面历史仍由 echo 日志回放)。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { migrateTranscript } = require('./sessions');
const keys = require('./keys');

// --- semver 比较(只取前三段数字,够本项目的 x.y.z 用) -----------------------
function compareVersions(a, b) {
  const pa = String(a || '0').split('.');
  const pb = String(b || '0').split('.');
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

// --- repairs:每次启动都跑的幂等自愈 -----------------------------------------

// resume 记录健康检查(核心存量坑:transcript 按 cwd 分目录,cwd 一变 resume 即死)。
// 记录不在当前 cwd 目录 → migrateTranscript 迁移(登记目录找不到时全盘兜底扫描);
// 全盘也找不到 → 清 sdkSessionId 降级全新会话(界面历史仍由 echo 日志回放),
// 避免用户点到时 resume 必失败把会话卡死(v0.9.7/v0.9.10 的坑,这里从 lazy 变主动)。
function repairTranscripts(report) {
  const norm = (p) => path.resolve(p || '').toLowerCase();
  for (const meta of store.listSessions()) {
    if (!meta.sdkSessionId || !meta.cwd) continue;
    // prevCwd 与 cwd 相同的残留登记直接清掉(无害脏数据)
    if (meta.prevCwd && norm(meta.prevCwd) === norm(meta.cwd)) {
      store.upsertSession({ id: meta.id, prevCwd: null });
      meta.prevCwd = null;
      report.prevCwdCleaned = (report.prevCwdCleaned || 0) + 1;
    }
    if (migrateTranscript(meta.sdkSessionId, meta.prevCwd || null, meta.cwd)) {
      if (meta.prevCwd) { // 迁移成功,登记已被消费
        store.upsertSession({ id: meta.id, prevCwd: null });
        report.transcriptMigrated = (report.transcriptMigrated || 0) + 1;
      }
    } else {
      store.upsertSession({ id: meta.id, sdkSessionId: null, prevCwd: null, resumeLostAt: Date.now() });
      report.transcriptLost = (report.transcriptLost || 0) + 1;
      (report.lostSessions = report.lostSessions || []).push(meta.title || meta.id);
    }
  }
}

// 会话 meta 去重(按 id 保留首条;upsert 语义下不应出现,出现即历史脏数据)
function repairSessionMeta(report) {
  const list = store.listSessions();
  const seen = new Set();
  let dirty = 0;
  const kept = [];
  for (const m of list) {
    if (!m || !m.id || seen.has(m.id)) { dirty++; continue; }
    seen.add(m.id);
    kept.push(m);
  }
  if (dirty) {
    store.update((s) => { s.sessions = kept; });
    report.metaDeduped = dirty;
  }
}

// 创作会话 board 戳补齐(v0.9.38):meta.board = 会话最近一次可解析的生成类型。
// 它存在的意义:modelGroups 之后被清空(刷新失败回退 /v1/models)时,aigc:send
// 仍可按 board 兜底建单——否则迁移后的 kind='media' 会话无从解析生成类型。
// 只盖不删;当下无从解析(modelGroups 已失效且从未盖过戳)时保持原样。
const MEDIA_BOARDS = ['image', 'video', 'audio', 'model'];
function repairMediaBoard(report) {
  for (const meta of store.listSessions()) {
    if (!meta || meta.kind !== 'media' || !meta.model || !meta.keyId) continue;
    if (MEDIA_BOARDS.includes(meta.board)) continue; // 已有有效戳
    let t = null;
    try { t = keys.modelType(meta.keyId, meta.model); } catch {}
    if (MEDIA_BOARDS.includes(t)) {
      store.upsertSession({ id: meta.id, board: t });
      report.mediaBoardStamped = (report.mediaBoardStamped || 0) + 1;
    }
  }
}

const REPAIRS = [repairTranscripts, repairSessionMeta, repairMediaBoard];

// --- migrations:按版本一次性执行的数据改写 -----------------------------------
// 模板:
//   { version: '0.9.18', desc: '做什么/为什么', run(ctx) { /* ctx.store */ } },
const MIGRATIONS = [
  // v0.9.38:四大媒体板块合并为「创作」(data-sec=media)——四类会话 kind
  // (image/video/audio/model)统一为 'media',生成类型改由所选模型的
  // model_type 决定(模型网关 modelGroups),为跨模态会话(图→视频)打底。
  // 幂等:已是 'media'/其他 kind 的会话原样保留。
  {
    version: '0.9.38',
    desc: '媒体会话 kind 四合一 → media(板块合并)并盖 board 戳',
    run({ store }) {
      const LEGACY = ['image', 'video', 'audio', 'model'];
      for (const m of store.listSessions()) {
        if (m && LEGACY.includes(m.kind)) store.upsertSession({ id: m.id, kind: 'media', board: m.kind });
      }
    },
  },
];

// --- 入口 --------------------------------------------------------------------
function logsDir() {
  const { app } = require('electron');
  const dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function appendLog(report) {
  try {
    fs.appendFileSync(path.join(logsDir(), 'migrations.log'), JSON.stringify(report) + '\n', 'utf8');
  } catch (e) {
    console.error('[migrations] log write failed:', e.message);
  }
}

// 每次启动调用。currentVersion 传 app.getVersion();migrations 可注入(测试用)。
function run(currentVersion, migrations = MIGRATIONS) {
  const seen = store.getSetting('dataVersion', null);
  const report = { ts: new Date().toISOString(), from: seen, to: currentVersion, migrations: [] };

  for (const repair of REPAIRS) {
    try { repair(report); } catch (e) {
      console.error(`[migrations] repair ${repair.name} failed:`, e.message);
      (report.repairErrors = report.repairErrors || []).push(`${repair.name}: ${e.message}`);
    }
  }

  for (const m of migrations) {
    if (seen && compareVersions(m.version, seen) <= 0) continue; // 已执行过
    try {
      m.run({ store });
      report.migrations.push({ version: m.version, desc: m.desc, ok: true });
      console.log(`[migrations] ${m.version} ${m.desc}: ok`);
    } catch (e) {
      console.error(`[migrations] ${m.version} ${m.desc} failed:`, e.message);
      report.migrations.push({ version: m.version, desc: m.desc, ok: false, error: e.message });
    }
  }

  // 版本戳只前进不后退(回退安装旧版时保留新高戳,重升时不重复迁移)
  if (!seen || compareVersions(currentVersion, seen) > 0) {
    store.setSetting('dataVersion', currentVersion);
  }
  const touched = Object.keys(report).some((k) => !['ts', 'from', 'to', 'migrations'].includes(k)) || report.migrations.length;
  if (touched) appendLog(report);
  if (report.transcriptLost) {
    console.warn(`[migrations] ${report.transcriptLost} 个会话的 resume 记录缺失,已降级为全新会话:`, report.lostSessions);
  }
  return report;
}

module.exports = { run, compareVersions };
