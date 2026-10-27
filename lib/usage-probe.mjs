#!/usr/bin/env node
// 一次性「用量探针」：只在端口上的 bridge 太旧（没有 GET /v1/usage）时才会被 host.js 拉起来。
//
// 它只做一件事：读 tokens.json 里的 access_token，带 chatgpt-account-id 去问
// https://chatgpt.com/backend-api/wham/usage，把上游原始 JSON 打到 stdout：
//   { "ok": true, "raw": { ... } }
// 失败时：
//   { "ok": false, "error": { "code": "...", "message": "..." } }
//
// ⚠ 这里**不刷新 token、不写任何文件**（刷新逻辑在 bridge.mjs 里，那条路不能抄两遍）。
// ⚠ 任何情况下都不把 token 打到 stdout / stderr；错误信息里只出现 HTTP 状态码。
//
// 环境变量：
//   GPT_PROXY_TOKENS      tokens.json 路径（必填）
//   GPT_PROXY_USAGE_URL   默认 https://chatgpt.com/backend-api/wham/usage
//   HTTPS_PROXY / NODE_USE_ENV_PROXY=1  由调用方（host.js）设好，出网走本机代理

import fs from 'node:fs'

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const USAGE_URL = process.env.GPT_PROXY_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage'
const TOKENS_FILE = process.env.GPT_PROXY_TOKENS || ''

function out(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function fail(code, message) {
  out({ ok: false, error: { code, message } })
  process.exit(0)
}

function decodeJwt(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

if (!TOKENS_FILE) fail('NO_TOKENS_FILE', '没有配置 tokens 文件路径。')

let tokens
try {
  tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))
} catch {
  fail('TOKENS_UNREADABLE', `读不到 ${TOKENS_FILE}（还没登录？）`)
}

if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token === '') {
  fail('NO_ACCESS_TOKEN', `${TOKENS_FILE} 里没有 access_token，请重新登录。`)
}

if (Number(tokens.expires_at) > 0 && Number(tokens.expires_at) <= Date.now()) {
  fail('TOKEN_EXPIRED', 'access_token 已过期；让 bridge 跑一轮（它会自动刷新）或重新登录后再看用量。')
}

const accountId =
  (typeof tokens.account_id === 'string' && tokens.account_id) ||
  decodeJwt(tokens.access_token)?.[JWT_CLAIM_PATH]?.chatgpt_account_id ||
  ''

if (!accountId) fail('NO_ACCOUNT_ID', 'token 里找不到 chatgpt_account_id，请重新登录。')

const headers = {
  authorization: `Bearer ${tokens.access_token}`,
  originator: 'codex_cli_rs',
  'user-agent': 'codex_cli_rs (Windows; x64)',
  accept: 'application/json',
  'accept-encoding': 'identity',
  'chatgpt-account-id': accountId,
}

let response
try {
  response = await fetch(USAGE_URL, { method: 'GET', headers, signal: AbortSignal.timeout(20_000) })
} catch (error) {
  fail('NETWORK', `连不上用量接口：${String((error && error.message) || error)}（代理没开？）`)
}

const text = await response.text().catch(() => '')
if (response.status === 401) fail('UNAUTHORIZED', '上游返回 401：access_token 可能已失效，请让 bridge 刷新或重新登录。')
if (!response.ok) fail(`HTTP_${response.status}`, `用量接口返回 HTTP ${response.status}：${text.slice(0, 300) || '(空响应)'}`)

let raw
try {
  raw = JSON.parse(text)
} catch {
  fail('BAD_BODY', '用量接口返回了非 JSON 响应。')
}

out({ ok: true, raw })
