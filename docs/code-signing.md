# 代码签名(Drafter)

> 状态:**配置已预留,证书待补**。仓库里没有写任何签名字段,拿到证书后填两个环境变量即可生效,
> 不改代码、不改 `package.json`。

## 为什么要签

1. **安装/更新时不再被拦**。当前 `Drafter Setup X.Y.Z.exe` 与 `Drafter.exe` 都是未签名的 177 MB / 200 MB PE。
   未签名的大型可执行文件首次落盘时,杀软(本机是火绒)会做启发式检查;签名后走白名单信任链,首扫代价显著下降。
2. **消除 SmartScreen「未知发布者」**。未签名安装包每次新版本都会触发一次告警。
3. **NSIS 更新校验**。electron-builder 的 NSIS 更新流程在配置了 `win.publisherName` 时会校验发布者一致性;
   未签名时**不能**填 `publisherName`,否则更新会因发布者校验失败而中断。

## 现状怎么查

```bash
node build/verify-package.js dist/verify-<版本>     # 输出里的 signed 字段
node -e "console.log(require('./build/signature-status').signatureLine('dist/win-unpacked/Drafter.exe'))"
```

`build/signature-status.js` 用 `Get-AuthenticodeSignature` 读取真实状态,输出形如:

- `signed: NotSigned` —— 未签名(当前状态)
- `signed: Valid (CN=…, O=…, C=CN)` —— 已签名且证书链可信
- `HashMismatch` / `NotTrusted` —— 签了但文件被改过 / 证书链不受信,必须排查

## 拿到证书后怎么启用

electron-builder 原生识别下面两个环境变量,**不需要**在 `package.json` 里加 `certificateFile` 之类字段:

| 变量 | 含义 |
| --- | --- |
| `CSC_LINK` | 证书来源。推荐用 base64 编码的 `.pfx`(单行,便于放进 CI secret),也可以直接给 `.pfx` 文件路径 |
| `CSC_KEY_PASSWORD` | `.pfx` 的导出密码 |

```bash
# 把 .pfx 转成单行 base64(Windows: 用 certutil;类 Unix: 用 base64)
certutil -encode drafter.pfx drafter.pfx.b64      # 去掉 BEGIN/END 头尾与换行

export CSC_LINK="$(cat drafter.pfx.b64)"           # 或 CSC_LINK=/abs/path/drafter.pfx
export CSC_KEY_PASSWORD='…'
npm run build && npx electron-builder --publish never
```

未设置这两个变量时,electron-builder 打印 `no signing info identified, signing is skipped`
并**正常完成构建** —— 这就是「预留」的全部含义。

### 证书类型怎么选

- **OV(Organization Validation)**:几百到一千多元/年,需要企业实名材料。签发后 SmartScreen 信誉**要攒**,
  新证书头几周仍可能告警,但比完全未签名好得多。
- **EV(Extended Validation)**:两三千元/年以上,需硬件 token 或云签名服务。
  **SmartScreen 立即生效**,是企业分发的最优解。注意 EV 通常是硬件 token,
  在 CI 里要用云签名服务(Azure Trusted Signing / DigiCert KeyLocker)而不是 `CSC_LINK`。
- 只想自用/内部分发:可以用自签证书,但**对 SmartScreen 与火绒无效**,仅解决「文件完整性」问题。

### 生效前不要动 publisherName

只有当证书到位、构建确实产出 `signed: Valid` 之后,才能往 `package.json` 的 `build.win` 里加:

```json
"publisherName": "<证书 Subject 里的公司名>"
```

提前填会让 NSIS 更新流程的发布者校验与未签名的包对不上,导致**更新直接失败**。

## 强制签名(正式发版 / CI)

```bash
DRAFTER_REQUIRE_SIGNING=1 node build/verify-package.js dist/verify-<版本>
```

未签名会以非零码退出。建议在证书到位后把它接进发布脚本,避免「以为签了其实没签」。

## 与「更新后整机卡顿」的关系

签名能减轻首扫代价,但**真正止住卡顿的是给火绒加排除目录**:

```
C:\Program Files\Drafter
%LOCALAPPDATA%\drafter-updater
```

签名和杀软排除都不是代码能解决的,需要在目标机器上配置。本仓库的代码侧改动
(v0.15.17 收敛 `asarUnpack`,把安装目录散文件从 7,713 个降到 214 个)
只是**缩小了每次更新被扫描的文件面**。
