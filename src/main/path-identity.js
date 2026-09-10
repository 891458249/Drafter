const fs = require('fs');
const path = require('path');

// Resolve existing ancestors too: new files inside a junction must inherit its boundary.
function canonicalPath(value, cwd = process.cwd()) {
  let current = path.resolve(cwd, value);
  const suffix = [];
  for (;;) {
    try {
      current = path.join(fs.realpathSync(current), ...suffix);
      return process.platform === 'win32' ? current.toLowerCase() : current;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(current);
      if (parent === current) {
        const result = path.join(current, ...suffix);
        return process.platform === 'win32' ? result.toLowerCase() : result;
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

module.exports = { canonicalPath };
