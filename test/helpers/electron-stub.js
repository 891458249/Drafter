// Stub the 'electron' module so main-process modules that require it
// (store.js → app.getPath('userData')) load under plain node:test.
// Install BEFORE requiring any src/main module; each test file gets its
// own process under `node --test`, so module-level patching is safe.
const Module = require('module');

const originalLoad = Module._load;

function installElectronStub(userDataDir) {
  Module._load = function (request, ...rest) {
    if (request === 'electron') {
      return {
        app: { getPath: () => userDataDir },
        Notification: class {},
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
}

module.exports = { installElectronStub };
