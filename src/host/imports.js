// 宿主半边共用导入。构建脚本按顺序拼接本目录文件为一个 ESM 模块，
// 因此所有 import 集中在第一个文件，其余文件共享同一模块作用域。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
