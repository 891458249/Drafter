// 探针 round2:确认 xhspeed.xyz 的 ECONNRESET 是 SNI 定点阻断还是整 IP 被墙。
//  1) 同 IP + 原 SNI(预期 RST,复核)  2) 同 IP + 其他 SNI(若握手成功=按域名阻断)
//  3) DoH(1.1.1.1)解析对比系统 DNS(投毒检查)  4) DoH 得到的不同 IP + 原 SNI(仍 RST=与 IP 无关)
//  5) HTTP/80 Host 头测试(对照)
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const OUT = path.join(__dirname, 'probe-xhspeed2.out.txt');
fs.writeFileSync(OUT, '');
const log = (s) => fs.appendFileSync(OUT, `[${new Date().toISOString().slice(11, 19)}] ${s}\n`);

const watchdog = setTimeout(() => { log('WATCHDOG exit'); log('PROBE-DONE'); process.exit(3); }, 120000);
watchdog.unref();

function tlsProbe(host, servername, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({ host, port: 443, servername, rejectUnauthorized: false });
    const kill = setTimeout(() => { s.destroy(); resolve(`TIMEOUT after ${Date.now() - t0}ms`); }, timeoutMs);
    s.once('secureConnect', () => {
      const cert = s.getPeerCertificate();
      clearTimeout(kill); s.end();
      resolve(`HANDSHAKE-OK (${Date.now() - t0}ms) certCN=${cert && cert.subject && cert.subject.CN}`);
    });
    s.once('error', (e) => { clearTimeout(kill); resolve(`FAIL (${Date.now() - t0}ms) ${e.code || e.message}`); });
  });
}

function httpProbe(host, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port: 80 });
    const kill = setTimeout(() => { s.destroy(); resolve(`TIMEOUT after ${Date.now() - t0}ms`); }, timeoutMs);
    let buf = '';
    s.on('data', (c) => { buf += c.toString('utf8'); if (buf.length > 500) { clearTimeout(kill); s.destroy(); resolve(`HTTP-OK (${Date.now() - t0}ms) ` + JSON.stringify(buf.slice(0, 200))); } });
    s.once('connect', () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    s.once('error', (e) => { clearTimeout(kill); resolve(`FAIL (${Date.now() - t0}ms) ${e.code || e.message}`); });
    s.once('close', () => { clearTimeout(kill); if (buf) resolve(`HTTP-CLOSED (${Date.now() - t0}ms) ` + JSON.stringify(buf.slice(0, 200))); });
  });
}

(async () => {
  const sysIps = (await dns.lookup('xhspeed.xyz', { all: true })).map((a) => a.address);
  log(`system DNS: ${JSON.stringify(sysIps)}`);
  const ip = sysIps[0];

  log(`1) TLS ${ip} SNI=xhspeed.xyz      : ` + (await tlsProbe(ip, 'xhspeed.xyz')));
  log(`2) TLS ${ip} SNI=www.cloudflare.com: ` + (await tlsProbe(ip, 'www.cloudflare.com')));

  // DoH 对照
  let dohIps = [];
  try {
    const r = await fetch('https://1.1.1.1/dns-query?name=xhspeed.xyz&type=A', { headers: { accept: 'application/dns-json' } });
    const j = await r.json();
    dohIps = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
    log(`3) DoH 1.1.1.1: ${JSON.stringify(dohIps)} (match=${JSON.stringify(dohIps) === JSON.stringify(sysIps)})`);
  } catch (e) { log(`3) DoH FAIL: ${e.message}`); }

  const altIp = dohIps.find((x) => !sysIps.includes(x));
  if (altIp) log(`4) TLS ${altIp}(DoH 专有) SNI=xhspeed.xyz: ` + (await tlsProbe(altIp, 'xhspeed.xyz')));
  else log('4) DoH 与系统 DNS 结果一致,跳过异 IP 复核');

  log(`5) HTTP/80 ${ip} Host=xhspeed.xyz  : ` + (await httpProbe(ip)));
  log('PROBE-DONE');
})().catch((e) => { log('FATAL ' + (e && e.stack || e)); log('PROBE-DONE'); });
