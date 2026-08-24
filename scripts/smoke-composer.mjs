// DSH composer rc.7+ compatibility regression checks.
// Verifies that Wishadel keeps the native input machine intact while restoring
// visible draft text and keeping the mounted composer seat visible in settling.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const theme = readFileSync(resolve(root, 'src/theme.css'), 'utf8')
const client = readFileSync(resolve(root, 'src/client/conversation-tools.js'), 'utf8')
let failures = 0

function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures += 1
}

check('真实 textarea 恢复可见文字', /\[data-input-backdrop\] \+ textarea\[data-phase\][^{]*\{[^}]*color:\s*var\(--w-text\)\s*!important;[^}]*-webkit-text-fill-color:\s*var\(--w-text\)\s*!important;/s.test(theme))
check('backdrop 普通镜像文字隐藏', /\[data-input-backdrop\][^{]*\{[^}]*color:\s*transparent\s*!important;[^}]*-webkit-text-fill-color:\s*transparent\s*!important;/s.test(theme))
check('命令与引用装饰仍可着色', /\[data-input-backdrop\] \[data-decoration\][^{]*\{[^}]*-webkit-text-fill-color:\s*currentColor\s*!important;/s.test(theme))
check('settling 阶段 composer seat 保持可见', /\[data-phase="settling"\] \[data-composer-seat\][^{]*\{[^}]*visibility:\s*visible\s*!important;/s.test(theme))
check('未劫持原生输入与剪贴板事件', !/(?:document|textarea|input)\.addEventListener\(\s*['"](?:beforeinput|input|keydown|keyup|paste|copy|cut|compositionstart|compositionend)['"]/s.test(client))
check('优化回填仍走原生 input/change 事件', client.includes("new InputEvent('input'") && client.includes("new Event('change'"))

console.log(failures === 0 ? '\nCOMPOSER SMOKE ALL PASS' : `\nCOMPOSER SMOKE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
