# K-Line Countdown Sentinel

交易员桌面端 K 线周期倒计时提醒工具（Wails + Go + React + Tailwind）。

## 本地开发

1. 安装依赖：`go`、`node`、`wails`。
2. 前端依赖：
```bash
cd frontend
npm install
```
3. 启动开发：
```bash
wails dev
```

## 发布流程（GitHub Actions）

已内置工作流：`.github/workflows/release.yml`

- 触发条件：推送 tag（例如 `v1.0.0`）
- 自动执行：
  1. 构建 Windows `k-line.exe`
  2. 构建 macOS `k-line.app` 并打包 zip
  3. 自动创建 GitHub Release 并上传产物

### 使用方式

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 自动更新（已接入）

应用内已接入“检查更新”能力：

- 启动后自动检查 GitHub 最新 Release
- 设置页可手动“检查更新”
- 发现新版本后可一键打开 Release 下载页

### 关键实现

- 后端接口：`CheckForUpdates()` / `OpenURL()`
- 前端入口：设置面板“版本更新”区域
- 版本注入：Release 构建时通过 `ldflags` 注入
  - `main.Version` -> 当前 tag
  - `main.Repo` -> `${{ github.repository }}`

本地调试可选环境变量：

```bash
export KLINE_GITHUB_REPO=你的组织/你的仓库
```

> 说明：当前是“自动检查 + 一键跳转下载”更新方案，跨平台安装流程稳定、实现成本低。
