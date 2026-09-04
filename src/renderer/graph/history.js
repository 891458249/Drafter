// 撤销/重做历史事务栈(md「差量命令与结构共享快照混合双轨」):
// - 轻量属性变更(移动节点/微调数值):差量命令 revert/apply,同 key 连续操作合帧合并;
// - 拓扑重构与批量操作(连线/删除/导入):结构快照,变更前调用 commitSnapshot 捕获,
//   栈容量上限 30,超出剔除最早历史。
// 纯逻辑无 DOM 依赖。capture/restore 由集成层注入(序列化/重建图模型)。

export function createHistory({ limit = 30, capture, restore, mergeWindow = 800 } = {}) {
  const past = [];
  const future = [];
  let lastDeltaKey = null;
  let lastDeltaTime = 0;

  function push(entry) {
    past.push(entry);
    if (past.length > limit) past.shift();
    future.length = 0; // 新操作清空重做栈
    lastDeltaKey = null;
  }

  return {
    // 拓扑/批量变更前调用:捕获变更前全图状态
    commitSnapshot() {
      push({ kind: 'snapshot', state: capture() });
    },
    // 高频属性变更:同 key(如 'move:3')在合并窗口内连续调用只记第一条
    commitDelta({ key, revert, apply }) {
      const now = Date.now();
      if (key && key === lastDeltaKey && now - lastDeltaTime < mergeWindow) {
        lastDeltaTime = now;
        return; // 合并进上一条命令(其 revert 仍回到最初状态)
      }
      push({ kind: 'delta', revert, apply, key });
      lastDeltaKey = key || null; // push 会清合并状态,记录要在 push 之后
      lastDeltaTime = now;
    },
    // 连续操作结束(如拖拽 pointerup):切断后续合并
    breakMerge() { lastDeltaKey = null; },
    undo() {
      const e = past.pop();
      if (!e) return false;
      lastDeltaKey = null;
      if (e.kind === 'delta') {
        e.revert();
        future.push(e);
      } else {
        future.push({ kind: 'snapshot', state: capture() });
        restore(e.state);
      }
      return true;
    },
    redo() {
      const e = future.pop();
      if (!e) return false;
      lastDeltaKey = null;
      if (e.kind === 'delta') {
        e.apply();
        past.push(e);
      } else {
        past.push({ kind: 'snapshot', state: capture() });
        restore(e.state);
      }
      return true;
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get depth() { return past.length; },
    clear() { past.length = 0; future.length = 0; lastDeltaKey = null; },
  };
}
