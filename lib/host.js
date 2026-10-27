// DSH「ChatGPT 订阅服务 / 用量」· 宿主半边
//
// 干三件事：
//   1) 把 bridge/bridge.mjs 这个本地 Codex 代理变成 DSH 插件的一部分：
//      DSH 起来时如果 127.0.0.1:8787 空着，就自己 spawn 一个 bridge 子进程；
//      端口已经被占（不论是旧的手动 bridge 还是别的进程）就只探测、不抢端口。
//      自己 spawn 的那个子进程在插件卸载 / DSH 退出时一起回收；外部进程一根手指都不碰。
//   2) 把 ChatGPT 套餐额度（5 小时窗口 + 7 天窗口）拿到设置页显示。
//      优先读 bridge 的 GET /v1/usage（bridge 自己走代理、自己刷新 token）；
//      如果端口上蹲着的是没这条路由的旧 bridge，就退化成一次性子进程直连上游
//      /backend-api/wham/usage（只读 token，不刷新、不写 token 文件）。
//   3) 判「现在到底能不能调用 GPT」：经本地 bridge 发一次极小的真实模型调用（canary）。
//      代理端口通 / TLS 握手通过都只是中间证据；用户连上代理的目的只有一个——真的调到 GPT，
//      所以主灯以「这次真实调用成不成」为准。旧的 CONNECT + TLS 穿透探测降级为详情行。
//      见下面「调用探活（canary）」一节的注释。
//
// 红线（写死在代码里，不靠记性）：
//   · 从不读 ~/.dsh/.credentials.yaml
//   · 从不把 access_token / refresh_token 放进日志、HTTP 响应或设置页
//   · 从不 taskkill 整个 node.exe；只 kill 自己 spawn 的那个 pid
//   · 不碰 cordis.patch.yml 里已有的 chatgpt-local 路由

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 插件对外名字（也是 Client 模块 id、设置页 section id、路由前缀）。 */
export const name = 'dsh-gpt-auto-proxy'

/** 只需要宿主提供 webServer 来挂设置页用的 HTTP 路由。 */
export const inject = ['webServer']

const 路由前缀 = '/dsh-gpt-auto-proxy'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const 自带bridge = path.join(HERE, '..', 'bridge', 'bridge.mjs')
const 用量探针 = path.join(HERE, 'usage-probe.mjs')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const 配置路径 = path.join(DSH_HOME, 'gpt-auto-proxy.json')
const 数据目录 = path.join(DSH_HOME, 'gpt-auto-proxy')

/** 路径类环境变量：留空 / 未设 → 空串（表示「没配」）。 */
function 环境路径(键) {
  const v = process.env[键]
  return typeof v === 'string' ? v.trim() : ''
}

/** 路径存在性（空串一律当作不存在，避免 fs.existsSync('') 的平台差异）。 */
function 存在(路径) {
  return typeof 路径 === 'string' && 路径 !== '' && fs.existsSync(路径)
}

/**
 * 可选的「外部 bridge / 外部凭据」路径，默认空。
 *
 * 留空时只用插件自带的 bridge 副本（bridge/bridge.mjs），凭据读
 * ~/.dsh/gpt-auto-proxy/tokens.json。想接自己已有的 codex-bridge 实现，
 * 用 GPT_PROXY_BRIDGE_ENTRY / GPT_PROXY_TOKENS_FILE 指过去——
 * 不要把自己的本机绝对路径写进仓库。
 */
const 旧bridge = 环境路径('GPT_PROXY_BRIDGE_ENTRY')
const 旧tokens = 环境路径('GPT_PROXY_TOKENS_FILE')
const 默认代理 = 'http://127.0.0.1:7890'
const 默认用量上游 = 'https://chatgpt.com/backend-api/wham/usage'
/** 连通性探测打的目标：只要证明「经代理真的到了 ChatGPT」，随便一个 chatgpt.com 的 HTTPS 端点都行。 */
const 默认探测目标 = 'https://chatgpt.com/'
const 探测超时毫秒 = 3000

/**
 * 调用探活（canary）：一次极小的真实模型调用，经本地 bridge 走完整链路。
 *
 * 为什么主灯必须用它：代理端口有响应、TLS 握手成功，都只能证明「路可能通」；
 * 用户真正关心的是「现在能不能调 GPT」。token 失效、额度用尽、上游 5xx、
 * bridge 挂了，都会在这里原形毕露。
 *
 * 省额度：
 *   · 结果缓存 60 秒；设置页打开时跑一次，之后每 5 分钟最多一次（页面隐藏/关闭时
 *     客户端不会自动跑），不会每 5 秒打真实请求；
 *   · 60 秒缓存对「立即测试」也生效：连点按钮 / 多个页面同时点，60 秒内只回到缓存，
 *     不会重复打上游；bridge-down（没到模型）例外，允许 5 秒快重试；
 *   · 请求体是最小的：input="ping"、reasoning.effort="none"（实测 22 tokens / 1.6 秒）、
 *     stream=false，只等一个聚合结果；
 *   · bridge 会主动丢掉 max_output_tokens（Codex 后端不认这个字段），这里仍然写上，
 *     一是表达意图，二是万一 bridge 以后支持了就能直接生效。
 *   · 并发点击合并成一次，绝不因为连点两次就多花一次额度。
 */
const 默认探活模型 = 'gpt-6-sol'
const 探活缓存秒 = 60
const 探活超时毫秒 = 20_000

const 版本 = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || '?')
  } catch {
    return '?'
  }
})()

const 默认配置 = {
  autoStart: true,
  port: 8787,
  proxy: 默认代理,
  tokensFile: 存在(旧tokens) ? 旧tokens : path.join(DSH_HOME, 'gpt-auto-proxy', 'tokens.json'),
  bridgeEntry: 存在(旧bridge) ? 旧bridge : 自带bridge,
  usageUrl: 默认用量上游,
  usageCacheSeconds: 60,
  probeUrl: 默认探测目标,
  probeCacheSeconds: 6,
  canaryModel: 默认探活模型,
  canaryTimeoutMs: 探活超时毫秒,
}

// ---------- 配置 ----------

function 布尔(值, 兜底) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜底
}

function 数字(值, 兜底, 小, 大) {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.min(大, Math.max(小, Math.round(n)))
}

function 文本(值, 兜底) {
  return typeof 值 === 'string' && 值.trim() !== '' ? 值.trim() : 兜底
}

function 归一化(原始) {
  const o = 原始 && typeof 原始 === 'object' && !Array.isArray(原始) ? 原始 : {}
  return {
    autoStart: 布尔(o.autoStart, 默认配置.autoStart),
    port: 数字(o.port, 默认配置.port, 1, 65535),
    proxy: o.proxy === '' || o.proxy === false || o.proxy === 'none' ? '' : 文本(o.proxy, 默认配置.proxy),
    tokensFile: 文本(o.tokensFile, 默认配置.tokensFile),
    bridgeEntry: 文本(o.bridgeEntry, 默认配置.bridgeEntry),
    usageUrl: 文本(o.usageUrl, 默认配置.usageUrl),
    usageCacheSeconds: 数字(o.usageCacheSeconds, 默认配置.usageCacheSeconds, 15, 600),
    probeUrl: 文本(o.probeUrl, 默认配置.probeUrl),
    probeCacheSeconds: 数字(o.probeCacheSeconds, 默认配置.probeCacheSeconds, 5, 10),
    canaryModel: 文本(o.canaryModel, 默认配置.canaryModel),
    canaryTimeoutMs: 数字(o.canaryTimeoutMs, 默认配置.canaryTimeoutMs, 1000, 60_000),
  }
}

function 读配置() {
  try {
    return 归一化(JSON.parse(fs.readFileSync(配置路径, 'utf8')))
  } catch {
    return 归一化(null)
  }
}

function 写配置(值) {
  fs.mkdirSync(path.dirname(配置路径), { recursive: true })
  const tmp = `${配置路径}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(值, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, 配置路径)
}

/**
 * 找 node.exe。
 *
 * ⚠ 不能用 process.execPath 想当然：DSH 桌面版是 Electron，宿主进程的 execPath 可能是
 *   `<DSH 安装目录>/DeepSeek Harness.exe`，拿它 spawn bridge 会再开一个 DSH 实例。
 * 顺序：显式环境变量 → 当前进程本来就是 node → 本机已知 runtime → 扫 dsh-runtimes → execPath。
 */
function 找node() {
  const 候选 = []
  for (const 键 of ['DSH_NODE', 'DSH_NODE_BINARY', 'NODE_BINARY']) {
    if (process.env[键]) 候选.push(process.env[键])
  }
  if (/^(node|nodejs)(\.exe)?$/i.test(path.basename(process.execPath))) 候选.push(process.execPath)
  候选.push(path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
  try {
    const 根 = path.join(DSH_HOME, 'dsh-runtimes')
    for (const d of fs.readdirSync(根)) 候选.push(path.join(根, d, 'dependencies', 'node', 'bin', 'node.exe'))
  } catch {
    /* 没有这个目录就算了 */
  }
  for (const c of 候选) {
    try {
      if (c && fs.statSync(c).isFile()) return c
    } catch {
      /* 下一个 */
    }
  }
  return process.execPath
}

const NODE_BIN = 找node()

/** 只读 token 文件的元信息；access_token 读完即丢，绝不返回、绝不打印。 */function 读token元信息(file) {
  const 出 = { file, exists: false, accountId: null, expiresAt: null, expired: null }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    出.exists = true
    出.accountId = typeof raw.account_id === 'string' ? raw.account_id : null
    出.expiresAt = Number(raw.expires_at) || null
    出.expired = 出.expiresAt === null ? null : 出.expiresAt <= Date.now()
  } catch {
    /* 文件不在 / 读坏了：保持 exists=false，页面会提示去登录 */
  }
  return 出
}

// ---------- 小工具 ----------

function 现在() {
  return new Date().toISOString()
}

function 追加侧车日志(行) {
  const file = path.join(数据目录, 'sidecar.log')
  try {
    fs.mkdirSync(数据目录, { recursive: true })
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat && stat.size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, 行 + '\n', 'utf8')
  } catch {
    /* 日志失败不影响代理 */
  }
}

async function 请求json(url, { timeoutMs = 5000, ...opts } = {}) {
  const 控制器 = new AbortController()
  const 表 = setTimeout(() => 控制器.abort(new Error('timeout')), timeoutMs)
  try {
    const 响应 = await fetch(url, { ...opts, signal: 控制器.signal })
    const 文本体 = await 响应.text()
    let body = null
    try {
      body = 文本体 === '' ? null : JSON.parse(文本体)
    } catch {
      body = null
    }
    return { status: 响应.status, ok: 响应.ok, body, text: 文本体 }
  } finally {
    clearTimeout(表)
  }
}

function 端口通(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// ---------- 调用探活（canary）：一次真实的小请求 ----------

/** 把上游报错里可能夹带的凭据抹掉；页面和日志都只拿这个版本。 */
function 去敏(值) {
  return String(值 || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/((?:access|refresh|id)_token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, '$1=***')
    .replace(/(authorization)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=***')
    .slice(0, 400)
}

/** 把 bridge 的 HTTP 结果翻成主灯能用的结论；永远不 throw。 */
function 判读探活({ 状态码, 体, 文本, 毫秒, 模型, 端口 }) {
  const 错误体 = 体 && typeof 体 === 'object' && 体.error && typeof 体.error === 'object' ? 体.error : null
  const 错误码 = String((错误体 && (错误体.code || 错误体.type)) || '')
  const 上游文 = 去敏(
    (错误体 && 错误体.message) ||
      (体 && typeof 体.error === 'string' ? 体.error : '') ||
      String(文本 || '').trim().slice(0, 300),
  )
  const 失败 = (state, reason, suggestion, extra = {}) => ({
    state,
    ok: false,
    model: 模型,
    ms: 毫秒,
    httpStatus: 状态码 ?? null,
    code: 错误码 || extra.code || null,
    reason,
    suggestion,
    outputTokens: null,
    totalTokens: null,
    ...extra,
  })

  if (状态码 >= 200 && 状态码 < 300) {
    if (体 && 体.error) {
      return 失败(
        'upstream',
        `桥回了 HTTP ${状态码}，但响应体里带着错误：${上游文 || '没给原因'}`,
        '看「插件日志」里 bridge 的报错；稍后再点「立即测试」。',
      )
    }
    // 8787 上蹲着别的服务时也可能回 200（比如代理、静态页）。只认 Responses 的形状。
    const 像响应 =
      体 &&
      typeof 体 === 'object' &&
      (typeof 体.id === 'string' || 体.object === 'response' || typeof 体.status === 'string' || 体.usage)
    if (!像响应) {
      return 失败(
        'bridge-down',
        `127.0.0.1:${端口} 上有服务应答，但返回的不是 codex-bridge 的 Responses 结果${上游文 ? `：${上游文}` : '。'}`,
        '检查这个端口上是不是 codex-bridge；插件不会抢端口，先处理占用进程，再点「重启代理」。',
      )
    }
    const 用量 = 体 && typeof 体.usage === 'object' ? 体.usage : null
    return {
      state: 'ok',
      ok: true,
      model: (体 && typeof 体.model === 'string' && 体.model) || 模型,
      ms: 毫秒,
      httpStatus: 状态码,
      code: null,
      reason: '',
      suggestion: '',
      outputTokens: Number.isFinite(Number(用量?.output_tokens)) ? Number(用量.output_tokens) : null,
      totalTokens: Number.isFinite(Number(用量?.total_tokens)) ? Number(用量.total_tokens) : null,
    }
  }

  if (状态码 === 401) {
    return 失败(
      'token-invalid',
      `ChatGPT 拒绝了凭据（HTTP 401）：${上游文 || 'token 失效或过期'}`,
      '打开 codex-bridge 目录跑一次 login.mjs 重新登录 ChatGPT；token 会写回 tokens.json（本插件只读元信息，不读 token 内容）。',
    )
  }
  if (状态码 === 403) {
    return 失败(
      'forbidden',
      `ChatGPT 拒绝了这次调用（HTTP 403）：${上游文 || '登录有效，但这个账号/套餐没有这个模型的权限'}`,
      '403 不是 token 过期：先确认 ChatGPT 套餐（Plus / Codex）是否生效、模型是否有权限、当前账号有没有被风控/地区限制；如果最近换过账号或用的是共享账号，跑一次 login.mjs 换成有权限的账号。',
    )
  }
  if (状态码 === 429) {
    return 失败(
      'quota',
      `额度 / 频率限制（HTTP 429）：${上游文 || '上游没有给具体原因'}`,
      '等 5 小时 / 7 天窗口重置，或在 DSH 里换一个还有额度的模型；下面的额度卡里有重置倒计时。',
    )
  }
  // bridge 把「连不上 ChatGPT 后端」和上游 5xx 都收敛成 502，靠 code / 文案区分。
  const 网络样 = /UPSTREAM_UNREACHABLE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|FETCH_FAILED|fetch failed|连接 ChatGPT 后端失败|代理/i
  if (状态码 >= 500 || 状态码 === 502) {
    if (网络样.test(`${错误码} ${上游文}`)) {
      return 失败(
        'network',
        `链路到不了 ChatGPT（HTTP ${状态码}）：${上游文 || 'bridge 连不上上游'}`,
        '检查 Clash / VPN：确认本机代理端口有响应、开关已打开、节点有延迟；修好后点「立即测试」。',
      )
    }
    return 失败(
      'upstream',
      `ChatGPT 上游出错（HTTP ${状态码}${错误码 ? `，${错误码}` : ''}）：${上游文 || '上游没有给具体原因'}`,
      '上游临时 5xx，过一会儿再点「立即测试」；一直失败就看「插件日志」里 bridge 的报错。',
    )
  }
  if (状态码 === 400 || 状态码 === 404) {
    return 失败(
      'bad-request',
      `上游拒绝了这次探活请求（HTTP ${状态码}${错误码 ? `，${错误码}` : ''}）：${上游文 || '请求或模型不被接受'}`,
      '检查设置里的「探活模型」是否还存在、账号是否支持它；改完保存后再点「立即测试」。',
    )
  }
  return 失败(
    'error',
    `探活请求失败（HTTP ${状态码}）：${上游文 || '没有更多信息'}`,
    '看「插件日志」里 bridge 的报错；这通常不是网络问题。',
  )
}

/** 连 bridge 都打不到（或等太久）时的结论。 */
function 判读探活错误(错误, { 毫秒, 模型, 超时, 超时毫秒, 端口 }) {
  const 码 = String((错误 && (错误.code || (错误.cause && 错误.cause.code))) || '')
  const 文 = 去敏((错误 && 错误.message) || 错误 || '')
  if (超时 || /ABORT|TIMEOUT/i.test(码) || /ETIMEDOUT/i.test(码)) {
    return {
      state: 'network',
      ok: false,
      model: 模型,
      ms: 毫秒,
      httpStatus: null,
      code: 码 || 'TIMEOUT',
      reason: `超过 ${Math.round(超时毫秒 / 1000)} 秒没有拿到结果${文 ? `（${文}）` : ''}：bridge 可能卡在等上游。`,
      suggestion: '检查 Clash / VPN 的开关、节点和延迟；如果代理正常，看「插件日志」里 bridge 是否在上游超时。',
      outputTokens: null,
      totalTokens: null,
      timeout: true,
    }
  }
  if (/ECONNREFUSED/i.test(码)) {
    return {
      state: 'bridge-down',
      ok: false,
      model: 模型,
      ms: 毫秒,
      httpStatus: null,
      code: 码,
      reason: `127.0.0.1:${端口} 拒绝连接：本地 bridge 没有运行。`,
      suggestion: '点下面的「重启代理」把本地桥拉起来；如果端口被别的服务占着，先处理占用进程（插件不抢端口）。',
      outputTokens: null,
      totalTokens: null,
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE/i.test(码)) {
    return {
      state: 'network',
      ok: false,
      model: 模型,
      ms: 毫秒,
      httpStatus: null,
      code: 码,
      reason: `请求没发到上游（${码}${文 ? `：${文}` : ''}）。`,
      suggestion: '检查 Clash / VPN：确认本机代理端口有响应、开关已打开、节点有延迟；修好后点「立即测试」。',
      outputTokens: null,
      totalTokens: null,
    }
  }
  return {
    state: 'error',
    ok: false,
    model: 模型,
    ms: 毫秒,
    httpStatus: null,
    code: 码 || null,
    reason: `探活自己出错了：${文 || 码 || '未知错误'}`,
    suggestion: '看「插件日志」里的 canary 报错；必要时点「立即测试」重试。',
    outputTokens: null,
    totalTokens: null,
  }
}

/** 真的发一次极小请求；永远 resolve。 */
async function 跑探活(配置, 模型) {
  const 开始 = Date.now()
  const 超时毫秒 = Number(配置.canaryTimeoutMs) || 探活超时毫秒
  const 控制器 = new AbortController()
  let 超时 = false
  const 表 = setTimeout(() => {
    超时 = true
    控制器.abort()
  }, 超时毫秒)
  try {
    const 响应 = await fetch(`http://127.0.0.1:${配置.port}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer dsh-local',
      },
      body: JSON.stringify({
        model: 模型,
        input: 'ping',
        reasoning: { effort: 'none' },
        max_output_tokens: 16,
        stream: false,
        store: false,
      }),
      signal: 控制器.signal,
    })
    const 文本 = await 响应.text()
    let 体 = null
    try {
      体 = 文本 ? JSON.parse(文本) : null
    } catch {
      体 = null
    }
    return 判读探活({ 状态码: 响应.status, 体, 文本, 毫秒: Date.now() - 开始, 模型, 端口: 配置.port })
  } catch (错误) {
    return 判读探活错误(错误, { 毫秒: Date.now() - 开始, 模型, 超时, 超时毫秒, 端口: 配置.port })
  } finally {
    clearTimeout(表)
  }
}

// ---------- 连通性探测：真的能连上 ChatGPT 吗 ----------
//
// 为什么不能直接 fetch + HTTPS_PROXY：
//   NODE_USE_ENV_PROXY 只在 Node 进程启动时读一次，DSH 宿主进程未必带着这个环境变量；
//   undici 的 ProxyAgent 又要额外依赖。这里用 node:http 的 CONNECT 隧道，不依赖
//   环境变量、也不用每次探测都 spawn 子进程。
//
// 三步：
//   1) 连 127.0.0.1:7890，发 CONNECT <目标主机>:443
//   2) 在隧道里跟目标做 TLS 握手（SNI = 目标主机，默认校验证书链和主机名）
//   3) TLS 握上 = 本机 → 代理 → 上游整条链路真的通
//
// 三种状态：
//   proxy-down   连 7890 就失败（Clash / VPN 没启动）
//   tunnel-down  7890 在答话，但 CONNECT / TLS 没成功（开关没打开 / 节点没选 / 规则没就绪）
//   ok           证书是目标主机的，真的到了上游
//
// 关键区分：「Clash 对普通 GET 回 400」只能证明代理进程活着，不能证明出去了；
// 它伪造不了 chatgpt.com 的证书，所以只有证书校验通过的 TLS 握手才算 ok。
//
// ⚠ 清理时不能同时 destroy 裸 socket 和包着它的 tls socket：本机 node v24.21.0
//   会 ACCESS_VIOLATION（0xC0000005）直接崩掉整个宿主进程（实测过）。只关最外层那个。

/** 把配置里的代理地址拆成 {host, port, tls, 协议, 原文}；空 / 解析不了返回 null。 */
function 解析代理(值) {
  const 原文 = String(值 || '').trim()
  if (!原文) return null
  let u
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(原文) ? 原文 : `http://${原文}`)
  } catch {
    return null
  }
  const 协议 = String(u.protocol || '').replace(':', '').toLowerCase()
  const host = String(u.hostname || '').replace(/^\[|\]$/g, '')
  if (!host) return null
  return {
    host,
    port: Number(u.port) || (协议 === 'https' ? 443 : 80),
    tls: 协议 === 'https',
    协议,
    原文,
    认证: u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')}` : '',
  }
}

/** 把 TLS 层错误翻成一句人话（不出现任何 token / 凭据）。 */
function 证书原因(error, 主机) {
  const 码 = String((error && error.code) || '')
  const 文 = String((error && error.message) || error)
  if (/ALTNAME|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS_CERT/i.test(码)) {
    return `TLS 证书校验失败（${码}）：到手的不是 ${主机} 的证书，可能被劫持或走了直连`
  }
  if (/ETIMEDOUT|TIMEOUT/i.test(码)) return `TLS 握手超时（${码 || 文}）`
  if (/ECONNRESET|EPIPE|ECONNREFUSED|ECONNABORTED/i.test(码)) return `隧道被对端断开（${码}）：节点可能没连上`
  return `TLS 握手失败（${码 || 文}）`
}

/**
 * 经代理探测目标站点。永远 resolve，不 reject（探测失败本身就是结果）。
 * @returns {Promise<{state:'ok'|'tunnel-down'|'proxy-down'|'disabled', stage:string, reason:string, ms:number, proxy:string, target:string, timeout?:boolean, httpStatus?:number, code?:string}>}
 */
function 探测隧道(代理原文, 选项 = {}) {
  const url = 选项.url || 默认探测目标
  const 超时 = Number(选项.timeoutMs) > 0 ? Number(选项.timeoutMs) : 探测超时毫秒
  const 目标 = new URL(url)
  if (目标.protocol !== 'https:') {
    return Promise.resolve({ state: 'disabled', stage: 'config', reason: '探测目标不是 https 地址，没法验证证书', ms: 0, proxy: 代理原文, target: url })
  }
  const 主机 = 目标.hostname
  const 端口 = Number(目标.port) || 443
  const 代理 = 解析代理(代理原文)
  const 开始 = Date.now()

  return new Promise((resolve) => {
    let 结束 = false
    let 阶段 = 'proxy-connect'
    let 已连代理 = false
    let 请求 = null
    let 隧道 = null
    let 安全 = null
    let 总表 = null

    const 收 = (state, reason, extra = {}) => {
      if (结束) return
      结束 = true
      if (总表) clearTimeout(总表)
      try {
        请求 && 请求.destroy()
      } catch {
        /* 已经没了 */
      }
      try {
        const 外层 = 安全 || 隧道
        外层 && 外层.destroy()
      } catch {
        /* 已经没了 */
      }
      resolve({ state, stage: extra.stage || 阶段, reason, ms: Date.now() - 开始, proxy: 代理原文, target: url, ...extra })
    }

    总表 = setTimeout(() => {
      if (!已连代理) return 收('proxy-down', `连接代理 ${代理 ? `${代理.host}:${代理.port}` : '?'} 超时`, { timeout: true })
      收('tunnel-down', `${超时} 毫秒内没能连到 ${主机}`, { timeout: true, stage: 阶段 })
    }, 超时)

    if (!代理) return 收('disabled', '代理地址为空或无法解析', { stage: 'config' })
    if (代理.协议 !== 'http' && 代理.协议 !== 'https') {
      return 收('disabled', `只支持 HTTP(S) 代理，当前是 ${代理.协议}://（Clash 的混合端口直接用 http:// 就行）`, { stage: 'config' })
    }

    const 选 = 代理.tls ? https : http
    const 请求选项 = {
      host: 代理.host,
      port: 代理.port,
      method: 'CONNECT',
      path: `${主机}:${端口}`,
      headers: {
        host: `${主机}:${端口}`,
        'proxy-connection': 'keep-alive',
        ...(代理.认证 ? { 'proxy-authorization': 代理.认证 } : {}),
      },
      agent: false,
    }
    if (代理.tls) {
      请求选项.servername = 代理.host
      请求选项.rejectUnauthorized = true
    }
    try {
      请求 = 选.request(请求选项)
    } catch (error) {
      return 收('proxy-down', `代理地址不可用：${String((error && error.message) || error)}`, { stage: 'config' })
    }

    请求.once('socket', (socket) => {
      const 连上 = () => {
        已连代理 = true
      }
      if (socket.connecting) socket.once('connect', 连上)
      else 连上()
    })

    请求.once('error', (error) => {
      请求 = null
      const 码 = String((error && error.code) || '')
      const 文 = 码 || (error && error.message) || String(error)
      if (!已连代理) return 收('proxy-down', `连不上本机代理 ${代理.host}:${代理.port}（${文}）`)
      收('tunnel-down', `代理隧道建立失败（${文}）：进程在，但没给出可用隧道`, { stage: 阶段, code: 码 })
    })

    请求.once('connect', (res, socket, head) => {
      请求 = null
      隧道 = socket
      if (res.statusCode !== 200) {
        return 收('tunnel-down', `代理拒绝建立到 ${主机}:${端口} 的隧道（HTTP ${res.statusCode}）：开关没打开 / 节点没选 / 规则没就绪`, {
          httpStatus: res.statusCode,
          stage: 'connect',
        })
      }
      if (head && head.length > 0) {
        return 收('tunnel-down', '代理在隧道里提前返回了多余数据，握手没法继续', { stage: 'connect' })
      }
      阶段 = 'tls'
      try {
        安全 = tls.connect({ socket, servername: 主机, ALPNProtocols: ['http/1.1'], ...(选项.ca ? { ca: 选项.ca } : {}) })
      } catch (error) {
        return 收('tunnel-down', `TLS 握手启动失败：${String((error && error.message) || error)}`, { stage: 'tls' })
      }
      安全.once('secureConnect', () => {
        收('ok', `TLS 握手成功：证书属于 ${主机}，真的到了上游`, { stage: 'ok', 协议: 安全.getProtocol() })
      })
      安全.once('error', (error) => {
        收('tunnel-down', 证书原因(error, 主机), { stage: 'tls', code: error && error.code })
      })
      安全.once('close', () => {
        收('tunnel-down', 'TLS 连接在握手完成前被关闭', { stage: 'tls' })
      })
    })

    // 有的代理 / 状态码下 Node 不发 connect 而发 response：那也没有隧道
    请求.once('response', (res) => {
      if (结束) return
      收('tunnel-down', `代理没有建立隧道，而是回了 HTTP ${res.statusCode}`, { httpStatus: res.statusCode, stage: 'connect' })
    })

    阶段 = 'connect'
    请求.end()
  })
}

/** 等子进程退出；到点还没退就 SIGKILL（Windows 上等于 TerminateProcess，只打这一个 pid）。 */
function 等退出(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(true)
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    child.once('exit', () => finish(true))
    setTimeout(() => finish(false), timeoutMs)
  })
}

// ---------- 代理侧车 ----------

function 造侧车(ctx, 配置读取) {
  const 状态 = {
    status: 'stopped', // stopped | probing | starting | running | reused | conflict | error
    managed: false,
    child: null,
    pid: null,
    startedAt: null,
    lastError: '',
    health: null,
    entry: '',
    logs: [],
    failureCount: 0,
  }
  let 代 = 0
  let 监视表 = null
  let 重试表 = null
  let 用量表 = null
  let 注销 = false
  /** 用量缓存（所有请求共用；force=true 时才打上游）。 */
  const 用量缓存 = { at: 0, lastTryAt: 0, lastStateAt: 0, data: null, error: null, source: null }

  /**
   * 连通性探测缓存。设置页每 5 秒来读一次 /state：
   *   · 5–10 秒内复用上次结果，避免每次渲染都打网络；
   *   · 同一次探测只跑一个（进行中时后来的请求直接等它）；
   *   · 代理地址 / 探测目标 / 缓存秒数改了，下一次立刻重探。
   */
  const 连通缓存 = { at: 0, 值: null, 进行中: null, 代理: '', 上次状态: '' }

  function 连通视图() {
    const 配置 = 配置读取()
    const 值 = 连通缓存.值
    return {
      state: 值 ? 值.state : 'probing',
      target: 值?.target || 配置.probeUrl,
      proxy: 配置.proxy || '',
      timeoutMs: 探测超时毫秒,
      cacheSeconds: 配置.probeCacheSeconds,
      at: 连通缓存.at || null,
      ageSeconds: 连通缓存.at ? Math.round((Date.now() - 连通缓存.at) / 1000) : null,
      probing: Boolean(连通缓存.进行中),
      ms: 值?.ms ?? null,
      stage: 值?.stage ?? null,
      httpStatus: 值?.httpStatus ?? null,
      timeout: 值?.timeout === true,
      code: 值?.code ?? null,
      reason: 值?.reason || '',
    }
  }

  /** 读快照用：有结果就先给结果、过期了在后台重探；只有一次结果都没有时才等它（最多 3 秒）。 */
  async function 确保连通({ force = false, 等待 = false } = {}) {
    const 配置 = 配置读取()
    const 代理 = 配置.proxy || ''
    const 目标 = 配置.probeUrl || 默认探测目标
    const ttl = Math.max(5, Math.min(10, Number(配置.probeCacheSeconds) || 6)) * 1000

    if (!代理) {
      if (!连通缓存.值 || 连通缓存.值.state !== 'disabled') {
        连通缓存.值 = { state: 'disabled', stage: 'config', reason: '代理设置是空的，没有可探测的代理', ms: 0, proxy: '', target: 目标 }
        连通缓存.at = Date.now()
        连通缓存.代理 = ''
      }
      return 连通视图()
    }

    const 过期 = force || !连通缓存.值 || 连通缓存.代理 !== 代理 || 连通缓存.值.target !== 目标 || Date.now() - 连通缓存.at >= ttl
    if (过期 && !连通缓存.进行中) {
      连通缓存.代理 = 代理
      连通缓存.进行中 = 探测隧道(代理, { url: 目标, timeoutMs: 探测超时毫秒 })
        .then((r) => {
          连通缓存.值 = r
          连通缓存.at = Date.now()
          if (r.state !== 连通缓存.上次状态) {
            连通缓存.上次状态 = r.state
            记账(`连通探测：${r.state}（${r.ms} ms）${r.reason}`)
          }
          return r
        })
        .catch((error) => {
          连通缓存.值 = {
            state: 'tunnel-down',
            stage: 'error',
            reason: `探测自己出错了：${String((error && error.message) || error)}`,
            ms: 0,
            proxy: 代理,
            target: 目标,
          }
          连通缓存.at = Date.now()
          return 连通缓存.值
        })
        .finally(() => {
          连通缓存.进行中 = null
        })
    }
    if (等待 && 连通缓存.进行中) {
      try {
        await 连通缓存.进行中
      } catch {
        /* 上面已经兜底成 tunnel-down */
      }
    }
    return 连通视图()
  }

  /** 点「重新检测」走这里：真的再探一次，最多等 3 秒。 */
  async function 强制连通() {
    if (连通缓存.进行中) {
      try {
        await 连通缓存.进行中
      } catch {
        /* 忽略 */
      }
    }
    if (连通缓存.值 && Date.now() - 连通缓存.at < 1000) return 连通视图()
    return 确保连通({ force: true, 等待: true })
  }

  /**
   * 调用探活缓存。主灯只看它：
   *   · 结果缓存 60 秒；/state 每 5 秒来读，只读缓存，绝不触发真实调用；
   *   · 只有设置页可见时 /canary 会在打开时跑第一次，之后每 5 分钟最多一次；
   *   · force=true（「立即测试」）也要过 60 秒缓存这道门，避免连点重复消耗；
   *     但 bridge-down 例外（没到模型），允许 5 秒快重试。
   */
  const 探活缓存 = { at: 0, 值: null, 进行中: null, 目标: '', 上次状态: '' }

  async function 探活视图() {
    const 配置 = 配置读取()
    const 值 = 探活缓存.值
    const 视图 = {
      state: 值 ? 值.state : 探活缓存.进行中 ? 'probing' : 'idle',
      ok: 值 ? 值.ok : null,
      model: 值?.model || 配置.canaryModel || 默认探活模型,
      ms: 值?.ms ?? null,
      at: 探活缓存.at || null,
      ageSeconds: 探活缓存.at ? Math.round((Date.now() - 探活缓存.at) / 1000) : null,
      cacheSeconds: 探活缓存秒,
      probing: Boolean(探活缓存.进行中),
      httpStatus: 值?.httpStatus ?? null,
      code: 值?.code ?? null,
      reason: 值?.reason || '',
      suggestion: 值?.suggestion || '',
      outputTokens: 值?.outputTokens ?? null,
      totalTokens: 值?.totalTokens ?? null,
      timeout: 值?.timeout === true,
    }
    // 429 不能一句「额度用尽」了事：把「5 小时窗口用满（马上会重置）」和
    // 「7 天窗口/额度真耗尽（要等很久）」分开，页面才好告诉用户等多久。
    // 诊断用现拉的 /v1/usage，不拿几分钟前的缓存数字下结论。
    if (视图.state === 'quota') 视图.quota = await 额度诊断()
    return 视图
  }

  /** 窗口用满的判据：≥95% 就算满（上游可能提前限流，别等 99.5%）。 */
  const 额度满阈值 = 95

  /** 429 诊断缓存：同一个 canary 结果只现场拉一次用量；页面每 5 秒轮询 /state 时直接复用，不重复打上游。 */
  const 额度诊断缓存 = { at: 0, 探活At: 0, 值: null }

  /** 429 时现场拉一次 /v1/usage，区分「5 小时窗口用满」与「周额度耗尽」；没有数据就说不知道。 */
  async function 额度诊断() {
    const 探活时间 = 探活缓存.at || 0
    // 同一个 canary 结果（60 秒内不会变）只拉一次；5 秒轮询和连点都复用这份诊断。
    // 注意不能只按时间防抖：canary 结果一换（新的 429 事件）就必须重新拉，否则会拿旧窗口下结论。
    if (额度诊断缓存.值 && 额度诊断缓存.探活At === 探活时间) return 额度诊断缓存.值
    // 429 已经发生：缓存里的数字可能是几分钟前的，必须 force 现拉一次再下结论。
    const 用量 = await 取用量({ force: true })
    const 数据 = 用量.data
    const 视图 = {
      verdict: 'unknown', // primary | secondary | not-full | unknown
      planType: 数据?.account?.planType ?? null,
      primary: null,
      secondary: null,
      credits: 数据?.credits ?? null,
      /** 上游自己说的「不让调」：比窗口百分比更权威，优先看。 */
      upstreamLimited: 数据?.rateLimit?.limitReached === true || 数据?.rateLimit?.allowed === false,
      limitReachedType: 数据?.rateLimit?.limitReachedType ?? null,
      usageAgeSeconds: 用量.ageSeconds,
      usageStale: Boolean(用量.data && 用量.error),
    }
    if (!数据) {
      额度诊断缓存.at = Date.now()
      额度诊断缓存.探活At = 探活时间
      额度诊断缓存.值 = 视图
      return 视图
    }
    const 洗 = (w, label) => {
      if (!w || typeof w !== 'object' || !Number.isFinite(Number(w.usedPercent))) return null
      return {
        label,
        usedPercent: Number(w.usedPercent),
        resetAfterSeconds: Number.isFinite(Number(w.resetAfterSeconds)) ? Number(w.resetAfterSeconds) : null,
        resetAt: Number.isFinite(Number(w.resetAt)) ? Number(w.resetAt) : null,
      }
    }
    视图.primary = 洗(数据?.rateLimit?.primary, '5 小时窗口')
    视图.secondary = 洗(数据?.rateLimit?.secondary, '7 天窗口')
    const 满 = (w) => Boolean(w && w.usedPercent >= 额度满阈值)
    // 判据：先看上游是否已经明确限流（allowed=false / limitReached=true），
    // 再看窗口百分比；97% 这种「已经限流但没到 99.5%」必须报满，不能报「窗口没满」。
    if (满(视图.primary)) 视图.verdict = 'primary'
    else if (满(视图.secondary)) 视图.verdict = 'secondary'
    else if (视图.primary || 视图.secondary) 视图.verdict = 'not-full'
    额度诊断缓存.at = Date.now()
    额度诊断缓存.探活At = 探活时间
    额度诊断缓存.值 = 视图
    return 视图
  }

  /** 读快照用：只读缓存，不跑真实调用。 */
  async function 确保探活({ force = false, 等待 = false } = {}) {
    const 配置 = 配置读取()
    const 模型 = 配置.canaryModel || 默认探活模型
    const 目标 = `${配置.port}|${模型}`
    const 新鲜 = 探活缓存.值 && 探活缓存.目标 === 目标 && Date.now() - 探活缓存.at < 探活缓存秒 * 1000
    // 60 秒缓存是硬底线：连点「立即测试」、多个页面同时点，都不会重复打上游。
    // 唯一例外是 bridge-down（端口根本没人听）——那一步没到模型，允许 5 秒快重试。
    const 可快重试 = Boolean(探活缓存.值 && 探活缓存.值.state === 'bridge-down')
    if (新鲜 && (!force || !可快重试)) return await 探活视图()

    if (!探活缓存.进行中) {
      探活缓存.目标 = 目标
      探活缓存.进行中 = 跑探活(配置, 模型)
        .then((r) => {
          探活缓存.值 = r
          探活缓存.at = Date.now()
          if (r.state !== 探活缓存.上次状态) {
            探活缓存.上次状态 = r.state
            记账(`调用探活：${r.state}${r.ok ? `（${r.model}，${r.ms} ms）` : `（${r.reason}）`}`)
          }
          return r
        })
        .catch((error) => {
          探活缓存.值 = {
            state: 'error',
            ok: false,
            model: 模型,
            ms: 0,
            httpStatus: null,
            code: null,
            reason: `探活自己出错了：${去敏((error && error.message) || error)}`,
            suggestion: '看「插件日志」里的 canary 报错；必要时点「立即测试」重试。',
            outputTokens: null,
            totalTokens: null,
          }
          探活缓存.at = Date.now()
          return 探活缓存.值
        })
        .finally(() => {
          探活缓存.进行中 = null
        })
    }
    if (等待 && 探活缓存.进行中) {
      try {
        await 探活缓存.进行中
      } catch {
        /* 上面已经兜底成 error */
      }
    }
    return await 探活视图()
  }

  const 记账 = (文本) => {
    const 行 = `[${现在()}] ${文本}`
    状态.logs.push(行)
    if (状态.logs.length > 120) 状态.logs.splice(0, 状态.logs.length - 120)
    追加侧车日志(行)
    try {
      ctx.logger.info(`gpt-auto-proxy: ${文本}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  const 清表 = () => {
    if (监视表) clearInterval(监视表)
    if (重试表) clearTimeout(重试表)
    if (用量表) clearInterval(用量表)
    监视表 = null
    重试表 = null
    用量表 = null
  }

  function 挂输出流(stream, 标签) {
    let 残 = ''
    stream.setEncoding('utf8')
    stream.on('data', (块) => {
      残 += 块
      const 行们 = 残.split(/\r?\n/)
      残 = 行们.pop() ?? ''
      for (const 行 of 行们.slice(-20)) {
        if (行.trim() === '') continue
        // bridge 自己会打 JSONL；只留一句给人看，避免把设置页刷爆
        let 简短 = 行.slice(0, 400)
        try {
          const o = JSON.parse(行)
          if (o && o.msg) 简短 = `${o.level || 'info'} ${o.msg}${o.model ? ` (${o.model})` : ''}`
        } catch {
          /* 不是 JSON 就原样 */
        }
        状态.logs.push(`[${现在()}] ${标签}: ${简短}`)
        if (状态.logs.length > 120) 状态.logs.splice(0, 状态.logs.length - 120)
        追加侧车日志(`[${现在()}] ${标签}: ${行.slice(0, 2000)}`)
      }
    })
  }

  async function 探健康(port) {
    try {
      const r = await 请求json(`http://127.0.0.1:${port}/health`, { timeoutMs: 3000 })
      if (r.ok && r.body && r.body.service === 'codex-bridge') {
        return { kind: 'bridge', health: r.body }
      }
      return { kind: 'foreign', status: r.status }
    } catch {
      return { kind: 'free' }
    }
  }

  function 采纳外部(健康) {
    状态.status = 'reused'
    状态.managed = false
    状态.child = null
    状态.pid = 健康.pid ?? null
    状态.health = 健康
    状态.startedAt = Date.now() - (Number(健康.uptimeSeconds) || 0) * 1000
    状态.failureCount = 0
    记账(`端口 ${配置读取().port} 上已经有一个 codex-bridge 在跑（pid ${状态.pid}），直接复用，不抢端口`)
    用量缓存.lastTryAt = 0
    开表()
  }

  async function 起(强启 = false) {
    const g = ++代
    注销 = false
    清表()
    const 配置 = 配置读取()
    状态.lastError = ''
    状态.health = null
    状态.entry = ''
    // 先把自己管着的旧进程收掉（它可能已经死了，也可能端口换了）
    if (状态.child) {
      const 旧 = 状态.child
      状态.child = null
      尝试杀(旧)
      await 等退出(旧, 2500)
    }
    状态.managed = false
    状态.pid = null
    状态.status = 'probing'
    状态.startedAt = Date.now()

    const 占着 = await 端口通('127.0.0.1', 配置.port)
    if (g !== 代) return
    if (占着) {
      const 探 = await 探健康(配置.port)
      if (g !== 代) return
      if (探.kind === 'bridge') return 采纳外部(探.health)
      状态.status = 'conflict'
      状态.lastError =
        探.kind === 'foreign'
          ? `127.0.0.1:${配置.port} 被别的服务占用了（不是 codex-bridge），按规矩不抢端口。`
          : `127.0.0.1:${配置.port} 有进程在监听，但读不到 /health，按规矩不抢端口。`
      记账(状态.lastError)
      return
    }

    if (!配置.autoStart && !强启) {
      状态.status = 'stopped'
      状态.lastError = ''
      记账('自动启动已关闭：只探测端口，不拉起 bridge（点「重启代理」可以手动拉起）')
      return
    }

    const entry = fs.existsSync(配置.bridgeEntry) ? 配置.bridgeEntry : 自带bridge
    if (!fs.existsSync(entry)) {
      状态.status = 'error'
      状态.lastError = `找不到 bridge 入口：${entry}（插件自带的副本也丢了）`
      记账(状态.lastError)
      return
    }
    状态.entry = entry
    const env = {
      ...process.env,
      CODEX_BRIDGE_PORT: String(配置.port),
      CODEX_BRIDGE_TOKENS: 配置.tokensFile,
      CODEX_BRIDGE_USAGE_URL: 配置.usageUrl,
      CODEX_BRIDGE_PROXY: 配置.proxy || 'none',
      CODEX_BRIDGE_BOOTSTRAPPED: '1',
      NODE_USE_ENV_PROXY: 配置.proxy ? '1' : '0',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
    // 让 bridge 的日志落到插件自己的数据目录，避免和旧 bridge 的 bridge.log 混在一起
    env.CODEX_BRIDGE_LOG = path.join(数据目录, 'bridge.log')
    if (配置.proxy) {
      env.HTTPS_PROXY = 配置.proxy
      env.HTTP_PROXY = 配置.proxy
      env.https_proxy = 配置.proxy
      env.http_proxy = 配置.proxy
    } else {
      delete env.HTTPS_PROXY
      delete env.HTTP_PROXY
      delete env.https_proxy
      delete env.http_proxy
      env.NODE_USE_ENV_PROXY = '0'
    }

    const 日志路径 = path.join(数据目录, 'bridge.log')
    let child
    try {
      child = spawn(NODE_BIN, [entry], {
        cwd: path.dirname(entry),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      状态.status = 'error'
      const 原因 = String((error && error.message) || error)
      // 受限环境（例如在 DSH 沙箱里跑自测）不允许给子进程开管道，spawn 会同步抛 EPERM。
      // 生产路径不降级成 inherit：拿不到 stdout/stderr 等于静默丢日志。这里把原因和
      // 「日志到底在哪」写进 lastError，设置页就能直接告诉人去哪个文件看。
      状态.lastError =
        error && error.code === 'EPERM'
          ? `当前环境不允许给子进程开管道（EPERM）：${原因}。bridge 没有启动（生产路径不会降级成 inherit）；子进程日志位置：${日志路径}`
          : `spawn bridge 失败：${原因}。子进程日志位置：${日志路径}`
      记账(状态.lastError)
      return
    }
    状态.child = child
    状态.managed = true
    状态.pid = child.pid ?? null
    状态.status = 'starting'
    挂输出流(child.stdout, 'stdout')
    挂输出流(child.stderr, 'stderr')
    记账(`已启动 bridge（pid ${状态.pid}，端口 ${配置.port}，入口 ${entry}）`)

    child.once('error', (error) => {
      if (g !== 代) return
      状态.status = 'error'
      状态.lastError = `bridge 子进程错误：${String((error && error.message) || error)}`
      状态.health = null
      记账(状态.lastError)
      安排重试()
    })

    child.once('exit', (code, signal) => {
      if (g !== 代) return
      状态.child = null
      状态.health = null
      状态.managed = false
      状态.status = 'error'
      状态.lastError = `bridge 退出了（code ${code ?? '?'}${signal ? `，signal ${signal}` : ''}）`
      记账(状态.lastError)
      安排重试()
    })

    // 等它监听 + /health 可用（最多 20 秒）
    const 截止 = Date.now() + 20_000
    while (Date.now() < 截止) {
      if (g !== 代) return
      if (状态.child !== child || child.exitCode !== null) return
      const 探 = await 探健康(配置.port)
      if (g !== 代) return
      if (探.kind === 'bridge') {
        状态.health = 探.health
        状态.status = 'running'
        状态.failureCount = 0
        用量缓存.lastTryAt = 0 // 换到 bridge 的 /v1/usage 重新取一次
        记账(`bridge 已就绪（pid ${探.health.pid ?? '?'}，uptime ${探.health.uptimeSeconds ?? 0}s）`)
        开表()
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    状态.status = 'starting'
    状态.lastError = 'bridge 启动了，但 20 秒内 /health 还没就绪（可能还在等代理）。稍后刷新看看。'
    记账(状态.lastError)
    开表()
  }

  function 尝试杀(child) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }

  function 安排重试() {
    if (注销) return
    const 配置 = 配置读取()
    if (!配置.autoStart) return
    状态.failureCount += 1
    if (状态.failureCount > 5) {
      记账('bridge 连续失败超过 5 次，停止自动重试；改好配置后点「重启代理」。')
      return
    }
    const 延迟 = Math.min(30_000, 1500 * 2 ** (状态.failureCount - 1))
    if (重试表) clearTimeout(重试表)
    重试表 = setTimeout(() => {
      重试表 = null
      if (!注销) void 起()
    }, 延迟)
    记账(`${Math.round(延迟 / 1000)} 秒后重试启动 bridge`)
  }

  function 开表() {
    if (监视表) clearInterval(监视表)
    监视表 = setInterval(async () => {
      const 配置 = 配置读取()
      if (状态.status !== 'running' && 状态.status !== 'reused') return
      const 探 = await 探健康(配置.port)
      if (探.kind === 'bridge') {
        状态.health = 探.health
        return
      }
      if (状态.status === 'running') {
        // 子进程还在但 /health 不响应：可能是代理卡住了，先不动它，页面会显示
        状态.lastError = 'bridge 进程在，但 /health 暂时读不到'
        return
      }
      // 之前复用的外部 bridge 不在了：更新状态；自动启动开着就自己接管这个端口
      状态.status = 'stopped'
      状态.health = null
      状态.pid = null
      状态.lastError = `之前复用的外部 bridge 已经不在 127.0.0.1:${配置.port} 上了`
      记账(状态.lastError)
      if (配置.autoStart) {
        clearInterval(监视表)
        监视表 = null
        void 起()
      }
    }, 4000)
  }

  async function 停() {
    代 += 1
    注销 = true
    清表()
    const child = 状态.child
    状态.child = null
    状态.health = null
    状态.managed = false
    if (child) {
      尝试杀(child)
      const 走了 = await 等退出(child, 3000)
      if (!走了) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      记账('已回收插件自己 spawn 的 bridge 子进程')
    }
    状态.pid = null
    状态.status = 'stopped'
  }

  // ---------- 用量 ----------

  function 洗窗口(w, label) {
    if (!w || typeof w !== 'object') return null
    const used = Number(w.used_percent)
    return {
      label,
      windowSeconds: Number(w.limit_window_seconds) || null,
      usedPercent: Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
      remainingPercent: Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null,
      resetAfterSeconds: Number.isFinite(Number(w.reset_after_seconds)) ? Number(w.reset_after_seconds) : null,
      resetAt: Number.isFinite(Number(w.reset_at)) ? Number(w.reset_at) : null,
    }
  }

  /** 上游原始 JSON（旧 bridge 的直连探针会原样带回来）洗成和 /v1/usage 一样的形状。 */
  function 洗用量(raw) {
    const rate = raw?.rate_limit && typeof raw.rate_limit === 'object' ? raw.rate_limit : {}
    const credits = raw?.credits && typeof raw.credits === 'object' ? raw.credits : {}
    const reset = raw?.rate_limit_reset_credits && typeof raw.rate_limit_reset_credits === 'object' ? raw.rate_limit_reset_credits : {}
    const spend = raw?.spend_control && typeof raw.spend_control === 'object' ? raw.spend_control : {}
    return {
      ok: true,
      fetchedAt: 现在(),
      account: {
        email: typeof raw?.email === 'string' ? raw.email : null,
        planType: typeof raw?.plan_type === 'string' ? raw.plan_type : null,
        accountId: typeof raw?.account_id === 'string' ? raw.account_id : null,
        userId: typeof raw?.user_id === 'string' ? raw.user_id : null,
      },
      rateLimit: {
        allowed: rate.allowed !== false,
        limitReached: rate.limit_reached === true,
        limitReachedType: typeof raw?.rate_limit_reached_type === 'string' ? raw.rate_limit_reached_type : null,
        primary: 洗窗口(rate.primary_window, 'primary'),
        secondary: 洗窗口(rate.secondary_window, 'secondary'),
      },
      credits: {
        hasCredits: credits.has_credits === true,
        unlimited: credits.unlimited === true,
        balance: credits.balance ?? null,
        overageLimitReached: credits.overage_limit_reached === true,
      },
      resetCredits: {
        availableCount: Number.isFinite(Number(reset.available_count)) ? Number(reset.available_count) : null,
        applicableAvailableCount: Number.isFinite(Number(reset.applicable_available_count)) ? Number(reset.applicable_available_count) : null,
      },
      spendControl: {
        reached: spend.reached === true,
        individualLimit: spend.individual_limit ?? null,
      },
      modelUsage: raw?.model_usage && typeof raw.model_usage === 'object' ? raw.model_usage : null,
    }
  }

  /** 旧 bridge 没 /v1/usage 时的退路：一次性子进程直连 wham/usage（只读 token，不刷新）。 */
  function 直连取用量(配置) {
    return new Promise((resolve) => {
      if (!fs.existsSync(用量探针)) return resolve({ ok: false, error: '插件里缺 usage-probe.mjs' })
      const env = {
        ...process.env,
        GPT_PROXY_TOKENS: 配置.tokensFile,
        GPT_PROXY_USAGE_URL: 配置.usageUrl,
        NODE_USE_ENV_PROXY: 配置.proxy ? '1' : '0',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      }
      if (配置.proxy) {
        env.HTTPS_PROXY = 配置.proxy
        env.HTTP_PROXY = 配置.proxy
        env.https_proxy = 配置.proxy
        env.http_proxy = 配置.proxy
      } else {
        env.NODE_USE_ENV_PROXY = '0'
        delete env.HTTPS_PROXY
        delete env.HTTP_PROXY
        delete env.https_proxy
        delete env.http_proxy
      }
      let child
      try {
        child = spawn(NODE_BIN, [用量探针], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        return resolve({ ok: false, error: `起用量探针失败：${String((error && error.message) || error)}` })
      }
      let out = ''
      let err = ''
      const 表 = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: '用量探针 25 秒没返回（代理不通？）' })
      }, 25_000)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (c) => {
        out += c
      })
      child.stderr.on('data', (c) => {
        err += c
      })
      child.once('error', (error) => {
        clearTimeout(表)
        resolve({ ok: false, error: `用量探针错误：${String((error && error.message) || error)}` })
      })
      child.once('exit', () => {
        clearTimeout(表)
        try {
          const body = JSON.parse(out.trim().split(/\r?\n/).pop() || '{}')
          if (body && body.ok) return resolve(body.data ?? 洗用量(body.raw ?? body))
          resolve({ ok: false, error: String(body?.error?.message || body?.error || err || '用量探针没有返回可用数据').slice(0, 500) })
        } catch {
          resolve({ ok: false, error: `用量探针输出不可解析：${(out || err).slice(0, 300)}` })
        }
      })
    })
  }

  function 缓存视图() {
    const 配置 = 配置读取()
    const age = 用量缓存.at ? Math.round((Date.now() - 用量缓存.at) / 1000) : null
    return {
      ok: Boolean(用量缓存.data),
      stale: Boolean(用量缓存.data && 用量缓存.error),
      ageSeconds: age,
      source: 用量缓存.source,
      error: 用量缓存.error,
      data: 用量缓存.data,
      cacheSeconds: 配置.usageCacheSeconds,
    }
  }

  async function 取用量({ force = false } = {}) {
    const 配置 = 配置读取()
    const ttl = 配置.usageCacheSeconds * 1000
    // 失败也吃缓存（lastTryAt），否则设置页每 5 秒轮询会把上游打爆
    if (!force && Date.now() - (用量缓存.lastTryAt || 0) < ttl) return 缓存视图()
    // 正在探测/启动：先别急着自己连上游，等 bridge 起来后它自己带 /v1/usage
    if (!force && (状态.status === 'probing' || 状态.status === 'starting')) return 缓存视图()
    用量缓存.lastTryAt = Date.now()

    // 1) 优先问 bridge（它自己走代理、自己刷新 token）
    const 有bridge = 状态.status === 'running' || 状态.status === 'reused'
    const 支持usage = 状态.health?.features?.includes('usage') === true
    if (有bridge && 支持usage) {
      try {
        const r = await 请求json(`http://127.0.0.1:${配置.port}/v1/usage`, { timeoutMs: 20_000 })
        if (r.ok && r.body && r.body.ok) {
          用量缓存.at = Date.now()
          用量缓存.data = r.body
          用量缓存.error = null
          用量缓存.source = 'bridge'
          return 缓存视图()
        }
        用量缓存.error = String(r.body?.error?.message || `bridge /v1/usage 返回 HTTP ${r.status}`)
      } catch (error) {
        用量缓存.error = `读 bridge /v1/usage 失败：${String((error && error.message) || error)}`
      }
    }

    // 2) 旧 bridge / bridge 没起来：直接问上游（只读 token）
    const 直连 = await 直连取用量(配置)
    if (直连.ok) {
      用量缓存.at = Date.now()
      用量缓存.data = 直连
      用量缓存.error = null
      用量缓存.source = 'direct'
    } else {
      用量缓存.error = 直连.error
      if (!用量缓存.data) 用量缓存.source = 'none'
    }
    return 缓存视图()
  }

  function 开用量表() {
    if (用量表) return
    用量表 = setInterval(() => {
      // 设置页两分钟没来读，就别再定时打上游了
      if (Date.now() - (用量缓存.lastStateAt || 0) > 120_000) return
      if (状态.status !== 'running' && 状态.status !== 'reused') return
      void 取用量({ force: true })
    }, Math.max(30, 配置读取().usageCacheSeconds) * 1000)
  }

  // ---------- 对外快照 ----------

  /**
   * 统计该读哪个 bridge.log：
   *   新版 bridge 的 /health 会直接给 logFile；
   *   旧版（复用外部进程）没有这个字段，就猜 tokens.json 旁边的 bridge.log
   *   （手动启动的 bridge 默认就写在那儿），再不行才用插件自己的日志。
   */
  function 统计日志(配置) {
    const health = 状态.health
    if (health?.logFile) return health.logFile
    const 旁边 = path.join(path.dirname(配置.tokensFile), 'bridge.log')
    try {
      if (fs.statSync(旁边).isFile()) return 旁边
    } catch {
      /* 没有就下一个 */
    }
    return path.join(数据目录, 'bridge.log')
  }

  async function 快照() {
    用量缓存.lastStateAt = Date.now()
    const 配置 = 配置读取()
    const tokens = 读token元信息(配置.tokensFile)
    const health = 状态.health
    const 日志 = 统计日志(配置)
    // 三件事并行：连通探测（第一次最多 3 秒）、用量、本地统计
    const [连, 用量, 统计] = await Promise.all([确保连通({ 等待: true }), 取用量(), 读统计(日志, health?.stats)])
    const canary = await 探活视图()
    return {
      ok: true,
      version: 版本,
      now: Date.now(),
      config: 配置,
      paths: {
        configFile: 配置路径,
        dataDir: 数据目录,
        logFile: 日志,
        tokensFile: 配置.tokensFile,
        bridgeEntry: 状态.entry || 配置.bridgeEntry,
        bundledBridge: 自带bridge,
        node: NODE_BIN,
      },
      sidecar: {
        status: 状态.status,
        managed: 状态.managed,
        pid: 状态.pid,
        port: 配置.port,
        startedAt: 状态.startedAt,
        uptimeSeconds: 状态.startedAt ? Math.round((Date.now() - 状态.startedAt) / 1000) : null,
        hasUsageRoute: health?.features?.includes('usage') === true,
        health,
        lastError: 状态.lastError,
        logs: 状态.logs.slice(-40),
      },
      /** 代理到底能不能到 ChatGPT：ok / tunnel-down / proxy-down / disabled / probing（旧判据，现在只做详情） */
      connectivity: 连,
      /** 「现在能不能调用 GPT」主判据：一次真实模型调用的缓存结果（ok / token-invalid / quota / network / bridge-down / upstream …） */
      canary,
      usage: 用量,
      stats: 统计,
      tokens,
    }
  }

  // ---------- 统计 ----------

  const 统计缓存 = { at: 0, file: '', data: null }

  async function 读统计(file, healthStats) {
    if (统计缓存.data && 统计缓存.file === file && Date.now() - 统计缓存.at < 4000) {
      return { ...统计缓存.data, bridge: healthStats ?? null }
    }
    const 今日0点 = new Date()
    今日0点.setHours(0, 0, 0, 0)
    const 今日 = { requests: 0, ok: 0, errors: 0, totalMs: 0, inputItems: 0, models: {} }
    const 总 = { requests: 0, ok: 0, errors: 0, totalMs: 0, inputItems: 0, models: {} }
    const 最近 = []
    try {
      const stat = await fsp.stat(file)
      const 从 = Math.max(0, stat.size - 4 * 1024 * 1024)
      const fh = await fsp.open(file, 'r')
      try {
        const 长度 = stat.size - 从
        const buf = Buffer.alloc(长度)
        await fh.read(buf, 0, 长度, 从)
        for (const 行 of buf.toString('utf8').split(/\r?\n/)) {
          if (!行.startsWith('{')) continue
          let o
          try {
            o = JSON.parse(行)
          } catch {
            continue
          }
          const 时间 = Date.parse(o.t || '')
          const 是今天 = Number.isFinite(时间) && 时间 >= 今日0点.getTime()
          const 记 = (目标) => {
            if (o.msg === 'responses request') {
              目标.requests += 1
              目标.inputItems += Number(o.input_items) || 0
              const m = String(o.model || '?')
              目标.models[m] = (目标.models[m] || 0) + 1
            } else if (o.msg === 'responses done') {
              目标.ok += 1
              目标.totalMs += Number(o.ms) || 0
            } else if (o.msg === 'responses failed') {
              目标.errors += 1
            }
          }
          记(总)
          if (是今天) 记(今日)
          if (o.msg === 'responses done' || o.msg === 'responses failed') {
            最近.push({ t: o.t, ok: o.msg === 'responses done', model: o.model || '', ms: o.ms ?? null, status: o.status ?? null })
            if (最近.length > 8) 最近.shift()
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      /* 没有日志就是全 0 */
    }
    const 成品 = {
      today: { ...今日, avgMs: 今日.ok ? Math.round(今日.totalMs / 今日.ok) : null },
      total: { ...总, avgMs: 总.ok ? Math.round(总.totalMs / 总.ok) : null },
      recent: 最近.reverse(),
      logFile: file,
    }
    统计缓存.at = Date.now()
    统计缓存.file = file
    统计缓存.data = 成品
    return { ...成品, bridge: healthStats ?? null }
  }

  return { 状态, 起, 停, 快照, 取用量, 开用量表, 记账, 确保连通, 强制连通, 确保探活 }
}

// ---------- 插件本体 ----------

export function apply(ctx) {
  const 侧车 = 造侧车(ctx, 读配置)

  const 读体 = async (req) => {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      return JSON.parse(body || '{}')
    } catch {
      return {}
    }
  }
  const 回 = (res, o, status = 200) => {
    if (res.writableEnded || res.destroyed) return
    const 文 = JSON.stringify(o)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(文) })
    res.end(文)
  }
  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            try {
              回(res, { ok: false, 说: String((error && error.message) || error) }, 500)
            } catch {
              /* 已经断了 */
            }
          }
        },
      }),
    )

  // 状态：设置页打开时拉一次，之后每 5 秒轮询
  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    回(res, await 侧车.快照())
  })

  // 保存：只覆盖传上来的字段；端口 / 代理 / 凭据路径变了就把自己管的 bridge 重启
  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 旧 = 读配置()
    const 新 = 归一化({ ...旧, ...(来 && typeof 来 === 'object' ? 来 : {}) })
    const 要重启 = 新.port !== 旧.port || 新.proxy !== 旧.proxy || 新.tokensFile !== 旧.tokensFile || 新.bridgeEntry !== 旧.bridgeEntry
    写配置(新)
    if (!新.autoStart) {
      await 侧车.停()
      return 回(res, { ...(await 侧车.快照()), 说: '保存好了；自动启动已关闭，代理已停。' })
    }
    if (要重启) {
      void 侧车.起(true)
      return 回(res, { ...(await 侧车.快照()), 说: '保存好了；代理参数变了，正在按新配置重启。' })
    }
    回(res, { ...(await 侧车.快照()), 说: '保存好了。' })
  })

  // 重启：只重启插件自己 spawn 的；外部 bridge 只会重新探测，不抢端口
  路线(`${路由前缀}/restart`, async (req, res) => {
    await 读体(req)
    const 旧状态 = 侧车.状态.status
    await 侧车.起(true)
    const 快照 = await 侧车.快照()
    const 说 =
      快照.sidecar.status === 'reused'
        ? `端口 ${快照.config.port} 还是被外部 bridge 占着（pid ${快照.sidecar.pid ?? '?'}），已继续复用；要换成插件自己管，先关掉那个进程再点重启。`
        : 快照.sidecar.status === 'conflict'
          ? 快照.sidecar.lastError
          : 旧状态 === 'reused'
            ? '已经重新探测；端口空出来了，现在由插件自己启动 bridge。'
            : '已经重启完成。'
    回(res, { ...快照, 说 })
  })

  // 连通性探测：?force=1 或 POST {force:true} 时真的再探一次（最多 3 秒）
  路线(`${路由前缀}/probe`, async (req, res) => {
    let force = false
    if (req.method === 'POST') {
      const 来 = await 读体(req)
      force = Boolean(来 && (来.force === true || 来.refresh === true))
    } else {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      force = u.searchParams.get('force') === '1' || u.searchParams.get('refresh') === '1'
    }
    const 连 = force ? await 侧车.强制连通() : await 侧车.确保连通({ 等待: true })
    回(res, { ok: true, connectivity: 连 })
  })

  // 调用探活：主灯判据。默认吃 60 秒缓存；?force=1 或 POST {force:true} 才真的再打一次
  路线(`${路由前缀}/canary`, async (req, res) => {
    let force = false
    if (req.method === 'POST') {
      const 来 = await 读体(req)
      force = Boolean(来 && (来.force === true || 来.refresh === true))
    } else {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      force = u.searchParams.get('force') === '1' || u.searchParams.get('refresh') === '1'
    }
    const 探 = await 侧车.确保探活({ force, 等待: true })
    回(res, { ok: true, canary: 探 })
  })

  // 用量：默认吃缓存，?force=1 或 POST 才打上游
  路线(`${路由前缀}/usage`, async (req, res) => {
    let force = false
    if (req.method === 'POST') {
      const 来 = await 读体(req)
      force = Boolean(来 && (来.force === true || 来.refresh === true))
    } else {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      force = u.searchParams.get('force') === '1' || u.searchParams.get('refresh') === '1'
    }
    回(res, await 侧车.取用量({ force }))
  })

  // 生命周期：DSH 起来时自动起（autoStart 关掉时也先探测端口，页面能显示"已复用/被占用"）
  ctx.effect(() => {
    void 侧车.起()
    return () => {
      void 侧车.停()
    }
  }, 'gpt-auto-proxy: 代理生命周期')

  // 设置页打开期间需要定时刷新用量；取用量自身有缓存，闲置时几乎不打上游
  ctx.effect(() => {
    侧车.开用量表()
    return () => {}
  }, 'gpt-auto-proxy: 用量定时刷新')

  try {
    ctx.logger.info(`gpt-auto-proxy: v${版本} 已加载；配置文件 ${配置路径}；node ${NODE_BIN}`)
  } catch {
    /* ignore */
  }
}

/** 只给自测用：把内部小函数暴露出来，不参与 DSH 的任何调用。 */
export const __test = {
  解析代理,
  探测隧道,
  默认探测目标,
  探测超时毫秒,
  判读探活,
  判读探活错误,
  去敏,
  默认探活模型,
  探活缓存秒,
}
