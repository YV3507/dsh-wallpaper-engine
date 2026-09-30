# 开发备忘：BOM 事故与 DSH 插件生效机制

<!-- status-banner: code-is-truth -->
> **状态：历史记录（不反映现行实现）。** 这是 2026-08-23 一次本机排查的过程记录，其中的**绝对路径
> 属于当时的同步机器**（读者打不开），仅作取证线索保留。
> **仍然生效的两条结论已经离开本文**：
> · BOM —— 发布面与 `test/**` 都不得带 BOM，由 `test/verify-package-files.mjs` 的 **P8** 按扩展名全扫
>   （判据在守卫里，不在本文）；写文件的正确姿势写在 `docs/DEV-GUIDE.md` §4.7 约定 7。
> · 热挂载 / 重启语义 —— 写在 `CONTRIBUTING.md` 与 `docs/CODE-STRUCTURE.md` §1.1。
> 写作纪律见 [`../README.md`](../README.md) §写作纪律。

> 记录于 2026-08-23 排查 DSH Desktop 启动失败后。

## 1. UTF-8 BOM 事故（已发生，勿重犯）

**现象**：DSH Desktop 启动失败，`finalStage: profile-composition`，
`SyntaxError: Unexpected token '﻿' ... is not valid JSON`（readProfileManifest 内 JSON.parse）。

**根因**：`C:\Users\Kai\.dsh\profiles\desktop\package.json` 开头被写入 UTF-8 BOM（EF BB BF）。
来源是 PowerShell 5.1 的 `Set-Content -Encoding UTF8` —— **PS 5.1 的 UTF8 编码默认带 BOM**。
Node 的 `JSON.parse` 不会剥离 BOM，直接抛错。

**修复**：字节级移除 BOM（首字节恢复为 `{` / 0x7B），内容不动。

**正确写法**（PowerShell 5.1 写无 BOM UTF-8）：

```powershell
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
```

（PS 7+ 可直接 `Set-Content -Encoding utf8NoBOM`。）
写任何会被 Node/JSON 解析器读取的文件（`.dsh\profiles\*\package.json`、配置 JSON）时**必须**用无 BOM 编码。

**自查命令**（扫描目录内所有 JSON 是否有 BOM）：

```powershell
Get-ChildItem <dir> -Recurse -Filter *.json | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $_.FullName }
}
```

## 2. DSH bundle patch / 热挂载机制

- **hot-mount（热挂载）只支持纯 insert 行**（patch 中仅新增内容的行）。
- **bundle patch 含配置/表达式行**（config / expression rows）**不支持热挂载**——修改后必须
  **重启 DSH**，由 bundle 层在启动时重新组合生效。
- 对 dsh-wallpaper-engine 的意义：
  - host 侧改动（`lib/index.js`、`lib/routes/*.js`）都是
    启动时加载的代码，**任何修改都要重启 DSH Desktop 才生效**；运行中的实例不会热更新 host 代码。
  - 客户端（`lib/client.js`）改动在 dev 模式下可热挂载（纯 insert），生产同样以重启为准。

## 3. 相关排查路径速查

- DSH Desktop 错误日志：`C:\Users\Kai\AppData\Roaming\DSH Desktop\logs\dsh-<date>.error.log`
- 插件安装恢复状态：`C:\Users\Kai\AppData\Roaming\DSH Desktop\plugin-install-recovery\state.json`
  （CLI 在应用运行期间安装 → `startup-unconfirmed` 自动回滚；正确流程：应用完全关闭 →
  执行 `dsh plugin --profile desktop add link:<path>` → 重启应用确认 `verified`）
- 场景帧缓存：`C:\Users\Kai\.dsh-wallpaper-engine\cache\frames\`（缓存键前缀 `lf1` / `sv1_` / `sa1_`
  标识渲染逻辑版本；改动渲染器后必须 bump 前缀，否则旧坏帧被复用）
