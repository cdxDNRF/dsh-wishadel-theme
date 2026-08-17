# DeepSeek Harness 插件加载异常分析与修复报告

| 项目 | 内容 |
|---|---|
| 报告日期 | 2026-08-17 |
| 问题现象 | `npx @deepseek-ai/dsh web` 打开后报 `Failed to load plugins` |
| 涉及版本 | dsh `0.1.0-rc.7` |
| 影响插件 | `@cdxdnrf/dsh-client-ui-skin-wishadel`、`dsh-vision-router` |
| 结论 | **插件未适配 dsh 新版本，非插件开发破坏 dsh 本身** |
| 状态 | ✅ 已修复并验证 |

---

## 1. 错误现象

启动 dsh 后，客户端插件加载器报错：

```
Failed to load plugins
  @cdxdnrf/dsh-client-ui-skin-wishadel
  dsh-vision-router
  failed to apply loader entry 487faecd (@cdxdnrf/dsh-client-ui-skin-wishadel):
  keyed slot "settings.plugin.item" requires options.key
```

## 2. 根因分析

dsh 升级到 `0.1.0-rc.7` 后，`settings.plugin.item` 这个 slot 的**契约发生破坏性变更**：

| | 旧契约 | 新契约 |
|---|---|---|
| slot 类型 | `list`（列表槽） | `keyed`（键控槽） |
| 注册必填字段 | `id` | `key` |
| 渲染方式 | 列出所有注册条目 | 按「已服务命名空间」派发 |

### 2.1 错误来源（dsh 源码）

`@deepseek-ai/dsh-client-ui-slots/lib/index.js`：

```js
// 行 77
if (options.key === void 0) throw new Error(`keyed slot "${options.name}" requires options.key`);
// 行 83
if (options.id === void 0) throw new Error(`list slot "${options.name}" requires options.id`);
```

槽类型声明 `dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`：

```ts
'settings.plugin.item': {
    kind: 'keyed';
    scope: 'root';
    owner: SettingsPluginItemOwnerProps;
};
```

### 2.2 为什么只改 `key` 还不够

新版 `ConfigurablePluginsTab` 只会派发「已服务（served）」的命名空间——它先读
`ctx.settings.describe()` 拿到 Host 侧注册过的命名空间列表，再对每个命名空间
`renderSlot("settings.plugin.item", {}, { entryKey: ns })`。因此：

1. 卡片注册必须用 `key: <namespace>`（否则抛「requires options.key」）。
2. Host 侧必须用 `ctx.settings.register(ns, schema)` 登记同名命名空间（否则卡片
   即使注册成功也**不会被渲染**，表现为静默消失）。

## 3. 两个失败插件的定位

| 插件 | 出错位置 | 旧写法 | 处理 |
|---|---|---|---|
| `wishadel-theme`（自研） | `lib/client.js:512` | `id: 'wishadel-theme'` | 改 `key` + 注册命名空间（本次修复） |
| `dsh-vision-router` 1.3.0（npm 包） | `lib/client.js:2240` | `id: 'vision-router'` | 临时禁用（后续升级 1.5.2） |

> 补充确认：`wishadel-theme` 中 `id: 'wishadel-theme'` 自提交 `0962e7c` 起未变，
> 本次排查未发现插件开发引入了该问题——纯粹是 dsh 升级导致的兼容性破坏。

## 4. 修复方案

### 4.1 wishadel-theme（代码适配，未动任何功能/界面）

**① 客户端槽注册**（`src/client/settings-card.js`）

```diff
   ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
     name: 'settings.plugin.item',
-    id: 'wishadel-theme',
-    order: 30,
-    label: '维什戴尔终端',
+    key: 'wishadel',
     inject: () => ({
       hooks: { wishadelSettings: settingsStore },
       actions: { save: (patch) => settingsStore.save(patch), refresh: () => settingsStore.refresh() },
     }),
   }, WishadelSettingsCard)), 'wishadel: settings card')
```

**② 宿主侧注册命名空间**（`src/host/apply.js`）

```js
// 新增 schemastery 命名空间声明（仅作「服务声明」，卡片读写仍走 /wishadel/settings）
const WISHADEL_NAMESPACE_SCHEMA = Schema.object({
  theme: Schema.union([Schema.const('wishadel'), Schema.const('none')]).default('wishadel'),
  themeOptions: Schema.object({
    chrome: Schema.boolean().default(true),
    sidebarArt: Schema.boolean().default(true),
    conversationArt: Schema.boolean().default(true),
  }),
  // ... taskboard / gitgraph / panel 各节，字段与 zod 版对齐
})

export function apply(ctx) {
  // ...
  // 用 ctx.inject 而非顶层 inject，settings 服务缺失时不阻断插件加载
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (sctx) => {
      sctx.settings.register('wishadel', WISHADEL_NAMESPACE_SCHEMA)
    })
  }
  // ...
}
```

**③ 引入 schemastery**（`src/host/imports.js` + `package.json`）

```diff
 import { z } from 'zod'
+import Schema from '@deepseek-ai/schemastery'
```

```diff
   "dependencies": {
+    "@deepseek-ai/schemastery": "^3.18.1",
     "zod": "4.4.3"
   },
```

> 设计取舍：按用户要求「只改适配、不动功能」，卡片读写继续走原有
> `/wishadel/settings` HTTP 通道 + `storages/wishadel/settings.json` 存储；
> 新增的 schemastery schema 仅用于把 `wishadel` 登记为「已服务命名空间」，
> 使卡片在新版 UI 中可见。后续如需彻底收敛为单套存储，可再迁移到
> `ctx.settings` 的 get/watch/update。

### 4.2 dsh-vision-router（临时禁用）

`C:\Users\DFWJ\.dsh\profiles\web\cordis.patch.yml`：

```diff
 - id: dsh-vision
   disabled: true
+- id: vision-router
+  disabled: true
```

> 1.3.0 未适配新契约，日志已提示 `update available 1.3.0 -> 1.5.2`。
> 恢复时删除上述两行并升级到 1.5.2 即可。

## 5. 验证结果

| 验证项 | 结果 |
|---|---|
| `node scripts/build.mjs`（重建 lib/） | ✅ 成功 |
| `node --check lib/index.js` | ✅ 通过 |
| `node --check lib/client.js` | ✅ 通过 |
| `node scripts/smoke-host.mjs`（宿主冒烟） | ✅ SMOKE ALL PASS |
| `node scripts/smoke-client.mjs`（客户端冒烟） | ✅ CLIENT SMOKE ALL PASS |
| 确认 `key: 'wishadel'` 已写入、`id: 'wishadel-theme'` 已移除 | ✅ |
| 确认 `sctx.settings.register('wishadel', …)` 已写入 lib/index.js | ✅ |

冒烟测试覆盖：设置读写、任务创建/更新/删除、cron 调度、文件列表/搜索/读取、
Git log/status/checkout、面板状态、终端启停、浏览器 loopback 防护等全链路均通过。

## 6. 后续建议

1. **重启验证**：`npx @deepseek-ai/dsh web`，确认不再弹 `Failed to load plugins`，
   「设置 > 插件」里 wishadel 卡片正常显示。
2. **dsh-vision-router 升级**：需要视觉路由时，删除 `cordis.patch.yml` 中的禁用行，
   升级到 1.5.2。
3. **依赖规整**：wishadel 插件目录的 `node_modules/.pnpm` 残留约 7MB 杂物
   （沙箱环境下 `npm install` 被打断所致），跑一次 `pnpm install` 可自动清理并锁定版本。
4. **可选迁移**：若要消除「两套设置存储」，可后续把 wishadel 设置迁移到
   `ctx.settings` 的 `scope.get()/watch()/update()`，并移除 `/wishadel/settings`
   路由与 `storages/wishadel/settings.json` 依赖。

## 7. 关键路径备忘

| 项 | 路径 |
|---|---|
| dsh profile 配置 | `C:\Users\DFWJ\.dsh\profiles\web\{package.json, cordis.patch.yml}` |
| dsh 实际安装（npx 缓存） | `/d/code_program/node_cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/` |
| 插件开发目录 | `D:\AIagent\DeepSeek\{wishadel-theme, dshmarket, dsh-vision}` |
| wishadel 构建入口 | `D:\AIagent\DeepSeek\wishadel-theme\scripts\build.mjs`（拼接 src/host、src/client） |

### slot 三种 kind 备忘

| kind | 必填字段 | 说明 |
|---|---|---|
| `single` | `priority` | 单例槽 |
| `list` | `id` | 列表槽，按 priority/order 排序 |
| `keyed` | `key` | 键控槽，按命名空间派发 |
| `chain` | `select` | 链式槽 |

### schemastery 转换备忘

- 默认导出即 `Schema`；`z.enum` 无对应，用 `Schema.union([Schema.const(a), Schema.const(b)])`。
- `Schema.object({...})` 空对象可解析出嵌套默认值。
- `.max()/.min()` 仅用于数字或集合长度；字符串长度约束需用 `.pattern()` 或去掉。
