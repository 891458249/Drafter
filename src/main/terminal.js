// Multi-terminal management (node-pty + xterm on the renderer side).
const os = require('os');

let pty = null;
try { pty = require('node-pty'); } catch (e) {
  console.error('[term] node-pty not available:', e.message);
}

class TermManager {
  constructor(getWindow, buildEnv) {
    this.getWindow = getWindow;
    this.buildEnv = buildEnv;
    this.terms = new Map(); // termId -> { term, cwd }
    this.nextId = 1;
  }

  _send(channel, payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  open({ cwd, cols = 80, rows = 24, command }) {
    if (!pty) return { ok: false, error: 'node-pty 不可用,终端无法启动' };
    const id = 't' + this.nextId++;
    // Windows shell 回退链:powershell.exe 可能不在 PATH(企业受限机),F-005
    const shells = process.platform === 'win32'
      ? ['powershell.exe', 'cmd.exe']
      : [process.env.SHELL || 'bash'];
    let term = null;
    let lastErr = null;
    let usedShell = null;
    for (const shell of shells) {
      try {
        term = pty.spawn(shell, [], {
          name: 'xterm-color', cols, rows,
          cwd: cwd || os.homedir(),
          env: this.buildEnv(),
        });
        usedShell = shell;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!term) {
      return { ok: false, error: `终端 shell 启动失败(${shells.join(' / ')}):${lastErr && lastErr.message}` };
    }
    try {
      if (command) term.write(command + '\r');
      term.onData((data) => this._send('term:data', { id, data }));
      term.onExit(({ exitCode }) => {
        this._send('term:exit', { id, code: exitCode });
        this.terms.delete(id);
      });
      this.terms.set(id, { term, cwd });
      return { ok: true, id, shell: usedShell };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (t) t.term.write(data);
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t) { try { t.term.resize(cols, rows); } catch {} }
  }

  close(id) {
    const t = this.terms.get(id);
    if (t) { try { t.term.kill(); } catch {} this.terms.delete(id); }
  }

  closeAll() {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}

module.exports = { TermManager };
