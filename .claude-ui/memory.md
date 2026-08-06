# ClaudeUI · 项目组共享记忆

(所有会话共用。跨会话需要记住的结论、决定、进展请追加到这里。)

- 2026-08-06 诊断:「设为项目文件夹」(proj:adoptDir, main.js:227) 只改 projectId 不切 cwd,导致会话主工作目录停在 C:\Users\dingyongzhen;叠加 ~/.claude/settings.local.json 残留的 permissions.additionalDirectories:["D:\ClaudeUI"],使无关路径出现在所有会话。修复方案:adoptDir 同步切换 cwd(含重启 query)、修存量 store 数据、删 settings.local.json 残留项。
- 2026-08-06 已修复(代码在仓库):①main.js proj:adoptDir 切换 cwd+清冗余 extraDirs+重启 query;②sessions.js addDir/start() 过滤与 cwd 相同的目录;③input.js adopt 分支同步 meta.cwd/state.cwd;④desktopui+claude-ui 两个 store 的 3 个存量会话 cwd 已修正(原文件留了 .bak-cwdfix 备份);⑤~/.claude/settings.local.json 的 additionalDirectories 已删。npm test 75/75 过。注意:正在运行的 App 需重启进程才生效。
- 2026-08-06 v0.9.7 已发布:commit c324e46(0.8.1→0.9.7 全部改动)已 push 到 891458249/Drafter;GitHub Release v0.9.7 已创建并上传 exe(147MB)+blockmap+latest.yml(electron-updater 可自动更新)。发布脚本:.claude-ui/release-0.9.7.js(复用 git credential 取 token,未入库)。注意:正在运行的 App 需重启进程才生效。
- 2026-08-06 坑:改存量会话的 cwd 会导致 resume 失败——Claude Code 按 cwd 分会话记录目录(~/.claude/projects/<cwd编码>/<sessionId>.jsonl),cwd 一变就在新目录找不到旧记录,报 "No conversation found with session ID" 会话终止(App 会自动开新会话接续)。cwd 修复的 3 个存量会话因此各中断过一次,属一次性代价。若将来要改 cwd 又保上下文:把旧目录下的 <sessionId>.jsonl 复制到新 cwd 对应目录再 resume。
