# Wishadel Demolition Terminal

面向 DeepSeek Harness Web GUI 的维什戴尔主题插件。

视觉方向不是传统游戏金属框，而是明日方舟式信息终端与维什戴尔爆破涂写：黑灰信息层、细线框、编号、警示切角、红色状态轨、网点和不对称构图。

## 覆盖范围

- Web GUI 全局背景与会话背景
- 宽侧栏、会话树、选中与运行状态
- 首页标题和输入器
- 对话头部、标签页、用户消息气泡
- 推理、上下文与工具调用行
- 问题卡、Todo、Cordis 审批面板
- 设置弹窗、菜单和浮层
- 响应式布局、减少动态效果
- 设置 → 插件 → 可配置中的启用、装饰和背景开关

所有素材都在预构建的 `lib/client.js` 中以内嵌 Data URI 分发，运行时不访问远程地址。

## 安装

要求：已经可以运行 DSH，Node.js 带 Corepack。

```powershell
git clone git@github.com:cdxDNRF/wishadel-theme.git
cd wishadel-theme
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

也可以使用 DSH 官方插件命令：

```powershell
corepack enable
pnpm --version
dsh plugin --profile web add git+https://github.com/cdxDNRF/wishadel-theme.git
```

安装后重启 `dsh web` 并刷新页面。

## 更新

在仓库目录拉取并重新安装：

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Source .
```

也可以在 Web profile 中运行 DSH 插件更新命令。

## 配置

打开 `设置 → 插件 → 可配置`，展开“维什戴尔终端”。可持久配置：

- 启用或停用主题
- 显示终端遥测与装饰线
- 显示侧栏角色图
- 显示会话背景

配置入口位于 DSH 设置页，修改后立即生效。由于 DeepSeek Harness `0.1.0-rc.6` 的 Web 配置 API 只向内置白名单开放 settings namespace，外部主题的选项保存在当前浏览器的 localStorage 中；插件安装、更新和卸载仍由 DSH profile 管理。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

脚本调用 DSH 官方插件管理机制，移除 package dependency 以及 `dsh.profile.bundles` 中对应的 bundle，不修改其他插件。

## 开发

源码与构建产物分离：

```text
assets/             背景素材
src/runtime.js      生命周期与 DOM 语义标记
src/theme.css       主题样式
scripts/build.mjs   无第三方依赖的构建脚本
lib/                提交到仓库的可安装产物
```

修改源码或素材后：

```powershell
node .\scripts\build.mjs
node --check .\lib\client.js
```

构建脚本会把 `assets/sidebar-w.jpg` 和 `assets/conversation-w.jpg` 嵌入客户端 bundle。

## 兼容性

当前针对 DeepSeek Harness `0.1.0-rc.6` Web GUI 验证。优先使用 `data-pane`、`data-phase`、`data-composer-*`、ARIA role/state 等稳定钩子，CSS Module 类名片段只作为兼容回退。

## 素材与许可

本项目是非商业性质的同人主题，与 Hypergryph/鹰角网络无隶属关系，也未获其背书。角色与《明日方舟》相关权利归各自权利人所有。详见 [NOTICE](NOTICE)。

项目代码和主题编排以 CC BY-NC-SA 4.0 发布。分发前请确保你有权重新分发替换后的背景素材。
