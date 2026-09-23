// Authenticode 签名状态查询(v0.15.17)。
//
// 为什么是「预留配置」而不是「现在就签」:electron-builder 原生读 CSC_LINK /
// CSC_KEY_PASSWORD 环境变量,未配置时自动跳过签名且构建不失败。所以仓库里不需要
// 写任何签名字段,拿到证书后把证书填进这两个环境变量即可生效。本模块只负责
// 「体检 + 如实报告」,让每次打包和发版都能看见当前到底签没签、签给谁。
//
// 申请与使用步骤见 docs/code-signing.md。
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// PowerShell 单引号字符串转义:内部单引号翻倍。路径经此进命令,避免反斜杠被转义。
const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";

/**
 * 读取一个 PE 文件的 Authenticode 状态。
 * @returns {{status: string, subject: string|null, reason?: string}}
 *   status 取 Get-AuthenticodeSignature 的 Status:Valid / NotSigned / HashMismatch /
 *   NotTrusted / UnknownError / Skipped(非 Windows 或被跳过)。
 */
function signatureStatus(file) {
  if (process.platform !== 'win32') return { status: 'Skipped', reason: 'non-win32' };
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    // 显式固定输出编码:证书 Subject 里常有中文机构名,默认 OEM 代码页会乱码。
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
    `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; ` +
    'Write-Output $s.Status.ToString(); Write-Output ([string]$s.SignerCertificate.Subject)'],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const [status = 'Unknown', ...rest] = out.split(/\r?\n/);
  return { status, subject: rest.join('\n').trim() || null };
}

/** 一行可读的签名摘要,供发版脚本打印。 */
function signatureLine(file) {
  const { status, subject } = signatureStatus(file);
  return subject ? `signed: ${status} (${subject})` : `signed: ${status}`;
}

module.exports = { signatureStatus, signatureLine };
