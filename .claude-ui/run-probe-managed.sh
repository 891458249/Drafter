#!/bin/bash
# 受管跑视频抽帧探针:launch 与 cleanup 必须在同一后台任务内完成。
# 原因:cli.js launch 秒退,若任务随之结束,宿主拆除控制台 → CTRL_CLOSE 杀死 supervisor
# → Job KILL_ON_JOB_CLOSE 硬杀目标进程树(本机三次静默死亡均已坐实,详见 memory.md)。
set -u
CLI="C:/Users/dingyongzhen/.claude/debug-runtime/87dfe784e25b6337a6d3bd8feb91a61315239b965e576b7a886fe06acccffcef/cli.js"
SCOPE="drafter:s_de05a856-723:ca991057-3046-416b-9ba6-f0c76dabd417:e172cd32-6777-4ef2-a024-5394f1a2ef7f"
OUT="D:/ClaudeUI/.claude-ui/probe-extract-e2e.out.txt"
env -u ELECTRON_RUN_AS_NODE node "$CLI" launch --scope "$SCOPE" --owner 89000 --cwd "D:\ClaudeUI" -- "D:\ClaudeUI\node_modules\electron\dist\electron.exe" "D:\ClaudeUI\.claude-ui\probe-extract-e2e.js"
echo "LAUNCH_RETURNED"
i=0
while [ $i -lt 300 ]; do
  if grep -qE "DONE|FATAL|UNCAUGHT" "$OUT" 2>/dev/null; then break; fi
  i=$((i+1)); sleep 1
done
echo "WAIT_END iterations=$i"
node "$CLI" cleanup --scope "$SCOPE"
node "$CLI" verify --scope "$SCOPE"
echo "SCRIPT_END"
