// 皮肤注册表：为后续更多主题提供统一挂载点。
// 其他主题 bundle 可通过 window.__dshSkins.register(def) 注册：
//   def = { id, name, nameEn?, apply(active, options) }
// 当前 bundle 注册 'wishadel' 皮肤；设置中的 theme 字段选择激活哪个。

const SKIN_DEFS = new Map()
const SKIN_STATE = new Map()

function registerSkin(def) {
  if (!def || typeof def.id !== 'string' || typeof def.apply !== 'function') throw new Error('皮肤定义缺少 id 或 apply')
  SKIN_DEFS.set(def.id, def)
  return () => SKIN_DEFS.delete(def.id)
}

function listSkins() {
  return [...SKIN_DEFS.values()].map((def) => ({ id: def.id, name: def.name ?? def.id, nameEn: def.nameEn ?? def.id }))
}

// 激活指定皮肤：目标 apply(true)，其余 apply(false)。id 为 null 时全部停用。
function activateSkin(id, options) {
  for (const [defId, def] of SKIN_DEFS) {
    const next = defId === id
    if (next !== SKIN_STATE.get(defId)) {
      SKIN_STATE.set(defId, next)
      try {
        def.apply(next, next ? options : {})
      } catch (error) {
        console.warn(`[wishadel] skin "${defId}" apply failed:`, error)
      }
    }
  }
}

// 本 bundle 的皮肤入口：由 runtime.js 在主题核心安装后注册。
function installWishadelSkin(applyVisuals) {
  registerSkin({
    id: 'wishadel',
    name: '维什戴尔终端',
    nameEn: 'Wishadel Demolition Terminal',
    apply(active, options) {
      applyVisuals(active, options)
    },
  })
}

window.__dshSkins = { register: registerSkin, list: listSkins, activate: activateSkin }
