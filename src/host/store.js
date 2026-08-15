// JSON 持久化：写入 $DSH_HOME/storages/wishadel/ 下，原子替换。
// 不依赖 settings/storage 服务，避免第三方命名空间白名单与 zod 实例跨包兼容问题。

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const storeDir = () => join(dshHome(), 'storages', 'wishadel')

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(join(storeDir(), file), 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(storeDir(), { recursive: true })
  const target = join(storeDir(), file)
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, target)
}

// 深度合并：对象递归合并，其余（数组/标量）整体替换。
function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) out[key] = mergeDeep(base[key], value)
  return out
}

function now() { return Date.now() }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
