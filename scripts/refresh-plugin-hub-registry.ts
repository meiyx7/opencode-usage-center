#!/usr/bin/env node
/**
 * 刷新 opencode-plugin-hub 的插件目录缓存。
 *
 * 为什么需要：plugin-hub 从 raw.githubusercontent.com 拉插件目录，该域在部分网络下
 * 被 TLS 重置（api.github.com 却可达），缓存过期后插件中心会一直显示 "fetch failed"。
 * 本脚本走 api.github.com 的 contents API 取同一份 registry.json 写入缓存，
 * 结构与插件自身的缓存 schema（{fetchedAt, url, entries[]}）完全一致。
 *
 * 用法：bun scripts/refresh-plugin-hub-registry.ts
 * 缓存有效期 12 小时（插件内置 ar=720*60*1000），过期后再跑一次即可。
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const SOURCES = [
  "https://api.github.com/repos/awesome-opencode/awesome-opencode/contents/dist/registry.json?ref=main",
  "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/dist/registry.json",
]

const cacheDir = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "opencode",
  "plugin-hub",
)
const cachePath = join(cacheDir, "registry.json")

let entries
let usedSource = ""
for (const url of SOURCES) {
  try {
    const headers: Record<string, string> = { accept: "application/json" }
    // contents API 的 raw 形态需要这个 accept
    if (url.includes("api.github.com")) headers.accept = "application/vnd.github.raw+json"
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data)) throw new Error("registry 格式不是数组")
    entries = data
    usedSource = url
    break
  } catch (cause) {
    console.warn(`源不可用 ${url}: ${cause instanceof Error ? cause.message : cause}`)
  }
}
if (!entries) {
  console.error("全部源不可用，缓存保持不变")
  process.exit(1)
}

let previousEntries: number | undefined
try {
  previousEntries = (JSON.parse(readFileSync(cachePath, "utf8")) as { entries?: unknown[] }).entries?.length
} catch {
  // 没有旧缓存
}

mkdirSync(cacheDir, { recursive: true })
writeFileSync(
  cachePath,
  JSON.stringify({ fetchedAt: Date.now(), url: usedSource, entries }),
  "utf8",
)
console.log(`已刷新插件目录缓存：${entries.length} 条（此前 ${previousEntries ?? 0} 条），来源 ${usedSource}`)
