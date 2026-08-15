// 解压会话日志（支持多帧 zstd），输出全部事件类型与工具调用。
// 用法：node scripts/inspect-session.mjs <session-dir>
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const dir = resolve(process.argv[2])
const file = readdirSync(dir).find((name) => name.endsWith('.zstd'))
if (!file) { console.log('未找到 .zstd 文件'); process.exit(1) }
const bytes = readFileSync(join(dir, file))
// 按 zstd 帧魔数（28 B5 2F FD）切分，逐帧解压。
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let start = 0
for (let i = 0; i <= bytes.length - 4; i++) {
  if (bytes[i] === MAGIC[0] && bytes[i + 1] === MAGIC[1] && bytes[i + 2] === MAGIC[2] && bytes[i + 3] === MAGIC[3]) {
    if (i > start) frames.push(bytes.subarray(start, i))
    start = i
  }
}
if (start < bytes.length) frames.push(bytes.subarray(start))
const chunks = frames.map((frame) => zstdDecompressSync(frame))
const text = Buffer.concat(chunks).toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log(`events: ${lines.length}`)
const counts = {}
for (const line of lines) {
  let event
  try { event = JSON.parse(line) } catch { continue }
  counts[event.type] = (counts[event.type] ?? 0) + 1
}
console.log('types:', JSON.stringify(counts))
for (const line of lines) {
  let event
  try { event = JSON.parse(line) } catch { continue }
  const t = event.type
  if (t === 'tool/call') {
    const data = event.data ?? {}
    const name = data.tool?.name ?? data.name ?? data.toolName ?? '?'
    const input = JSON.stringify(data.arguments ?? data.input ?? data.call ?? {}).slice(0, 260)
    console.log(`TOOL ${name} ${input}`)
  } else if (t === 'user/message') {
    const content = event.data?.message?.content ?? event.data?.content ?? event.data?.text ?? ''
    console.log(`USER ${JSON.stringify(content).slice(0, 260)}`)
  } else if (t === 'assistant/message') {
    const blocks = event.data?.message?.content ?? event.data?.content ?? []
    const texts = []
    const walk = (items) => {
      if (!Array.isArray(items)) return
      for (const block of items) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
    walk(blocks)
    console.log(`ASSISTANT ${texts.join(' ').slice(0, 300)}`)
  } else if (t === 'turn/end') {
    console.log(`TURNEND ${event.data?.reason?.kind ?? '?'}`)
  }
}
