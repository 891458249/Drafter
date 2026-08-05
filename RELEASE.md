# 发布流程(给维护者本人)

适用:Claude UI 桌面应用,仓库 `891458249/Drafter`(**public**,已确认 2026-07-31)。

## 标准发布步骤

1. 确认 `package.json` 的 `version` 已 bump,且对应 commit 已打同名 tag 并推送:
   ```bash
   git push origin main --tags
   ```
2. 本地构建安装包:
   ```bash
   npm run dist
   ```
   产物在 `dist/`:
   - `Claude UI Setup <version>.exe` — NSIS 安装包
   - `latest.yml` — 自动更新元数据(electron-updater 客户端按它检测版本)
3. 在 GitHub 网页创建 Release:
   - 打开 https://github.com/891458249/Drafter/releases/new
   - **Tag 选择与本版一致的现有 tag**(如 `v0.4.0`),Release 标题随意(建议同 tag)
   - 上传两个文件:`Claude UI Setup <version>.exe` 和 `latest.yml`
   - 发布(Publish release)
4. 完成。已安装的客户端下次启动时会自动检查、后台下载,顶栏出现「已就绪 · 点击重启」提示。

> 不要对仓库执行 `electron-builder --publish`(需要本机配置 GH_TOKEN,且容易误发);
> 一律走网页手动发 Release。

## 客户端更新行为

- 启动后自动 `checkForUpdates`(设置项 `updateCheck = false` 可关闭自动检查;顶栏更新 chip 点击可手动触发)。
- 状态展示:检查中 → 发现新版本(版本号)→ 下载进度 % → 已就绪(点击重启安装)。
- 检查失败(无网络、无 Release、开发环境未打包)**静默降级**,不打断使用。

## 如果仓库将来转为 private

electron-updater 的 github provider 对私有仓库读取 Release 需要 token:

- 方案 A:在客户端机器设置环境变量 `GH_TOKEN`(repo 只读权限的 PAT)后再启动应用;
- 方案 B:自建 generic 更新服务器(静态托管 `latest.yml` 与安装包),把 `build.publish`
  改为 `{ "provider": "generic", "url": "https://<你的服务器>/claude-ui/" }`;
- 无论哪种,都可以在设置中把 `updateCheck` 置为 `false` 彻底关闭自动检查(默认开)。

## 当前 NSIS 安装器行为

- 非一键安装(`oneClick: false`),用户可自选安装目录;
- 快捷方式名「Claude UI」;安装器/卸载器图标为 `build/icon.ico`(占位图标,可替换后重新 `npm run dist`)。

## 安装 / 覆盖安装 / 卸载(已静默实测,v0.6.3)

- **安装**:运行 `Claude UI Setup x.y.z.exe`,可选安装目录(默认 `%LocalAppData%\Programs\Claude UI`)。
- **覆盖安装(升级/重装)**:直接运行新版安装包即可——NSIS 会处理旧版替换,无需先手动卸载;静默实测同目录二次安装成功。自动更新走的也是这条路径。
- **卸载**:控制面板/开始菜单的「Uninstall Claude UI」,静默实测卸载后安装目录清空。**卸载默认保留用户数据**(会话记录、API Key、项目组配置在 `%AppData%\claude-ui`,`deleteAppDataOnUninstall: false`);要彻底删除请手动删该目录。
