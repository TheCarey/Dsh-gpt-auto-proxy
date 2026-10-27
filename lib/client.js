// DSH「ChatGPT 订阅服务 / 用量」· 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「订阅服务 / 用量」：
//   · ChatGPT 账号（邮箱 / 套餐 / account id）
//   · 两个额度窗口：5 小时（primary）与 7 天（secondary），已用 % + 剩余 % + 重置倒计时
//   · 本地 bridge 今天的请求数 / 成功率 / 平均耗时 / 最近几条
//   · 代理设置（端口、代理地址、tokens 路径、自动启动）+ 重启 / 刷新按钮
//
// 这里不直接调用模型：主灯「现在能不能调用 GPT」由宿主 /canary 路由在页面可见时
// 打开跑一次、之后每 5 分钟最多一次真实请求来判断；页面只负责轮询 /state、把结论翻成人话。
// 真正的 bridge 子进程、token、上游请求全在 lib/host.js 与 bridge/bridge.mjs 里。
// 页面上只显示 tokens 文件路径，**永远不显示 token 内容**。

window.__ModuleLoader__.load({
  id: 'dsh-gpt-auto-proxy',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const B = '/dsh-gpt-auto-proxy'
    const h = React.createElement

    /**
     * 主灯自动测试节奏：设置页可见时每 5 分钟最多跑一次真实调用（宿主 /canary 另有 60 秒缓存）。
     * 绿灯过期阈值必须从它推导，别在两处各写一个数字；以后调节奏只改这里。
     */
    const 自动测试间隔毫秒 = 300000
    const 自动测试间隔分钟 = Math.round(自动测试间隔毫秒 / 60000)
    /** 自动测试间隔 + 60 秒容差：超过这个时间还挂着的结果只能算「上次测试」。 */
    const 探活过期秒 = Math.round(自动测试间隔毫秒 / 1000) + 60

    const get = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    // ---------- 样式（贴着主题变量走，换深浅色跟着变） ----------

    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, wordBreak: 'break-all', userSelect: 'all' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
      角标: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: 11.5,
      },
      圆点: (色) => ({ width: 8, height: 8, borderRadius: 99, background: 色, display: 'inline-block' }),
      数字: { fontSize: 26, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
      tag: {
        display: 'inline-block',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        marginRight: 6,
        marginBottom: 4,
        opacity: 0.9,
      },
      bar: { height: 8, borderRadius: 999, background: 'rgba(127,127,127,.18)', overflow: 'hidden', margin: '8px 0 4px' },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      提示: (色, 底) => ({
        border: `1px solid ${色}`,
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 10,
        fontSize: 12,
        lineHeight: 1.7,
        color: 色,
        background: 底 || 'transparent',
      }),
      科目标签: { fontSize: 12, opacity: 0.75, marginBottom: 2 },
      最近行: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', opacity: 0.85 },
    }

    // ---------- 格式化 ----------

    const 状态表 = {
      running: { 文: '运行中（插件托管）', 色: '#2e9e5b' },
      reused: { 文: '复用外部 bridge', 色: '#c98a00' },
      starting: { 文: '启动中…', 色: '#c98a00' },
      probing: { 文: '探测端口…', 色: '#c98a00' },
      conflict: { 文: '端口被别的服务占用', 色: '#c0392b' },
      error: { 文: '出错', 色: '#c0392b' },
      stopped: { 文: '已停止', 色: '#888' },
    }

    const 百分比 = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}%` : '—')

    const 窗口名 = (秒) => {
      const s = Number(秒) || 0
      if (s >= 86400) return `${Math.round(s / 86400)} 天窗口`
      if (s >= 3600) return `${Math.round(s / 3600)} 小时窗口`
      if (s >= 60) return `${Math.round(s / 60)} 分钟窗口`
      return '额度窗口'
    }

    /** 重置倒计时：优先用上游的 reset_at（unix 秒），否则用 fetchedAt + reset_after_seconds。 */
    const 倒计时 = (窗口, 抓取时间) => {
      if (!窗口) return '—'
      const 基准 = Number.isFinite(Number(窗口.resetAt)) ? Number(窗口.resetAt) * 1000 : Date.parse(抓取时间 || '') + (Number(窗口.resetAfterSeconds) || 0) * 1000
      const 剩 = Math.max(0, 基准 - Date.now())
      if (!Number.isFinite(剩)) return '—'
      const 分总 = Math.floor(剩 / 60000)
      const 天 = Math.floor(分总 / 1440)
      const 时 = Math.floor((分总 % 1440) / 60)
      const 分 = 分总 % 60
      if (天 > 0) return `${天} 天 ${时} 小时`
      if (时 > 0) return `${时} 小时 ${分} 分`
      return `${分} 分`
    }

    const 进度色 = (已用) => {
      const n = Number(已用) || 0
      if (n >= 90) return '#c0392b'
      if (n >= 70) return '#d68910'
      return 'var(--dsw-alias-state-business-primary, #2f6fed)'
    }

    const 数字 = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—')

    const 短id = (id) => {
      const s = String(id || '')
      return s.length <= 12 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`
    }

    const 时刻 = (iso) => {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      const 补 = (n) => String(n).padStart(2, '0')
      return `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    }

    // ---------- 连通诊断 ----------
    //
    // 只改网页半边也要能分辨「代理没开」和「桥没起」：
    //   · 桥在不在 —— 直接看宿主 /state 的 sidecar.status（宿主每 4 秒探一次 8787 的 /health）
    //   · 代理通不通 —— 浏览器对 7890 发一个 no-cors GET：Clash 收到会回 400，
    //     只要 fetch 拿到响应就说明端口有人听；连接被拒绝会立刻 reject。结果缓存 5 秒。
    //   · 两边都不确定时，再看 /usage 的 error 里有没有「代理没开 / ECONNREFUSED / fetch failed」
    //     这类网络层字样。
    //
    // 浏览器探测只是加分项：用量刚刚取成功（有 data 且不 stale）时，说明代理和上游都通，
    // 以这个铁证为准，避免浏览器策略拦截探测时误报「代理未开」。

    const 解析代理 = (值) => {
      const 原文 = String(值 || '').trim()
      if (原文 === '') return { configured: false, host: '', port: 0, http: false, 原文 }
      let u
      try {
        u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(原文) ? 原文 : `http://${原文}`)
      } catch {
        return { configured: true, host: '', port: 0, http: false, 原文, bad: true }
      }
      const 协议 = String(u.protocol || '').replace(':', '').toLowerCase()
      return {
        configured: true,
        host: String(u.hostname || '').replace(/^\[|\]$/g, ''),
        port: Number(u.port) || (协议 === 'https' ? 443 : 80),
        http: 协议 === '' || 协议 === 'http' || 协议 === 'https',
        原文,
      }
    }

    const 代理地址 = (代理) => (代理 && 代理.host ? `${代理.host}:${代理.port}` : '—')

    /**
     * 探测一个本地 HTTP 端点。返回 true=有响应、false=连接被拒绝、null=超时/未知。
     * no-cors 让跨端口的请求不因 CORS 失败；Clash 的 400 响应也算「端口通」。
     */
    const 探测端点 = (url, 超时毫秒 = 900) =>
      new Promise((resolve) => {
        if (typeof fetch !== 'function') return resolve(null)
        const 控制器 = typeof AbortController === 'function' ? new AbortController() : null
        let 完 = false
        const 收 = (值) => {
          if (完) return
          完 = true
          clearTimeout(表)
          try {
            if (控制器) 控制器.abort()
          } catch {
            /* 已经结束 */
          }
          resolve(值)
        }
        const 表 = setTimeout(() => 收(null), 超时毫秒)
        const 起 = Date.now()
        try {
          fetch(url, { mode: 'no-cors', cache: 'no-store', ...(控制器 ? { signal: 控制器.signal } : {}) })
            .then(() => 收(true))
            .catch(() => 收(Date.now() - 起 < 500 ? false : null))
        } catch {
          收(false)
        }
      })

    /** 代理探测结果缓存：5 秒内复用，避免设置页每 5 秒轮询时重复打端口。 */
    const 探测缓存 = { 目标: '', at: 0, 值: null }
    let 探测中 = null

    const 取探测 = (代理) => {
      const 目标 = 代理 && 代理.configured ? 代理地址(代理) : ''
      if (目标 === '' || 探测缓存.目标 !== 目标) return undefined
      return Date.now() - 探测缓存.at < 5000 ? 探测缓存.值 : undefined
    }

    const 确保探测 = (代理) => {
      const 目标 = 代理地址(代理)
      const 旧 = 取探测(代理)
      if (旧 !== undefined) return Promise.resolve(旧)
      if (探测中) return 探测中
      const 主机 = 代理.host.includes(':') ? `[${代理.host}]` : 代理.host
      探测中 = 探测端点(`http://${主机}:${代理.port}/`, 900)
        .then((值) => {
          探测缓存.目标 = 目标
          探测缓存.at = Date.now()
          探测缓存.值 = typeof 值 === 'boolean' ? 值 : null
          return 探测缓存.值
        })
        .finally(() => {
          探测中 = null
        })
      return 探测中
    }

    /** 宿主/桥/上游给的都是中文错误；这里只认网络层失败，不认 401 / HTTP 5xx。 */
    const 网络错误样 = /(代理没开|代理是否可用|检查本机代理|代理不可用|ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|fetch failed|Connection error|network error|connect timeout)/i

    /**
     * 浏览器探测 127.0.0.1 只在「页面本来就是从本机打开的」时才有意义。
     * 如果用户从另一台机器远程打开 DSH，页面里的 127.0.0.1 指向的是浏览器那台机器，
     * 这时不探测，退回看 /usage 的错误。Electron / 测试环境没有 location 时也不探测。
     */
    const 页面可探测本机 = (() => {
      try {
        if (typeof location === 'undefined') return false
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return false
        const 名 = String(location.hostname || '').replace(/^\[|\]$/g, '')
        return 名 === '127.0.0.1' || 名 === 'localhost' || 名 === '::1'
      } catch {
        return false
      }
    })()

    /**
     * 页面是否可见。页面隐藏 / 关闭时，真实调用探活完全停表（省额度）。
     * Electron / 测试环境没有 document 时按「可见」处理，不影响功能。
     */
    const 页面当前可见 = () => {
      try {
        return typeof document === 'undefined' || document.visibilityState !== 'hidden'
      } catch {
        return true
      }
    }

    /**
     * 三态判定（纯函数，方便自测）：
     *   ok            代理真的能到 ChatGPT（宿主穿透探测通过 / 用量新鲜）
     *   proxy-down    连 7890 都连不上（Clash / VPN 没启动）
     *   tunnel-down   7890 在答话，但没连出去（开关没打开 / 节点没选 / 规则没就绪）
     *   bridge-off    链路是好的，但 8787 上没有可用的 codex-bridge
     * 另有 bridge-starting / no-proxy / usage-fail 几个辅助态，避免误报。
     *
     * 判定依据的优先级：
     *   1) 刚取到新鲜用量 = 整条链路都通过，这是最硬的证据；
     *   2) 宿主侧穿透探测（lib/host.js 真的走代理 CONNECT + TLS 到 chatgpt.com）——
     *      这是唯一能分清「代理进程答话」和「真的连出去了」的信号；
     *   3) 旧宿主没有 connectivity 时，退回浏览器对代理端口的 no-cors 探测：
     *      它只能说明端口有人听，不能说明出去了。
     */
    const 有宿主探测 = (连通) =>
      Boolean(连通 && (连通.state === 'ok' || 连通.state === 'tunnel-down' || 连通.state === 'proxy-down'))

    const 连通短句 = (连通) => {
      if (!连通) return ''
      const 毫秒 = 连通.ms !== null && 连通.ms !== undefined ? `，${连通.ms} ms` : ''
      const 细节 = 连通.reason ? `：${连通.reason}` : ''
      if (连通.state === 'ok') return `宿主穿透探测通过（到 ${连通.target || 'ChatGPT'}${毫秒}）`
      if (连通.state === 'tunnel-down') return `宿主穿透探测没通过${细节}`
      if (连通.state === 'proxy-down') return `宿主探测连不上代理${细节}`
      if (连通.state === 'probing') return '宿主穿透探测进行中…'
      return ''
    }

    const 诊断 = (态, 探测值) => {
      const 配置 = (态 && 态.config) || {}
      const 侧车 = (态 && 态.sidecar) || {}
      const 用量 = (态 && 态.usage) || {}
      const 连通 = 态 && 态.connectivity ? 态.connectivity : null
      const 宿主探测在 = 有宿主探测(连通)
      // 宿主正在探的时候，别拿浏览器探测的「连不上」去下结论（会误报代理未开）
      const 浏览器值 = 连通 && 连通.state === 'probing' ? null : 探测值
      const 代理 = 解析代理(配置.proxy)
      const 端口 = 配置.port || '?'
      const 桥在 = 侧车.status === 'running' || 侧车.status === 'reused'
      const 桥正启 = 侧车.status === 'starting' || 侧车.status === 'probing'
      const 有数据 = Boolean(用量.data)
      const 新鲜 = 有数据 && 用量.stale !== true && !用量.error
      const 错误 = String(用量.error || '')
      const 网络错 = 网络错误样.test(错误)
      // 代理端口可达：宿主探测优先（它连 7890 都连不上才算不可达），没有宿主探测才看浏览器
      const 代理可达 = 宿主探测在
        ? 连通.state !== 'proxy-down'
        : 新鲜
          ? true
          : typeof 浏览器值 === 'boolean'
            ? 浏览器值
            : null
      // 整条链路到 ChatGPT 通不通：宿主探测 ok / 新鲜用量 = 通；tunnel-down = 不通；不知道 = null
      const 链路通 = 宿主探测在 ? 连通.state === 'ok' : 新鲜 ? true : null
      // 这个「通」是谁证明的：probe=宿主真的握手成功；usage=刚取到新鲜用量
      const 链路来源 = 链路通 === true ? (宿主探测在 ? 'probe' : 'usage') : null
      const 代理名 = 代理.configured ? 代理地址(代理) : '（未配置代理）'
      const 状态文 = (状态表[侧车.status] && 状态表[侧车.status].文) || 侧车.status || '未知'
      const 探测依据 = 宿主探测在
        ? 连通短句(连通)
        : 连通 && 连通.state === 'probing'
          ? '宿主穿透探测进行中…'
          : 代理可达 === false
            ? `浏览器探测：${代理名} 连接被拒绝`
            : 代理可达 === true
              ? 新鲜
                ? `用量刚刚刷新成功（${代理名} 与上游都通）`
                : `浏览器探测：${代理名} 端口有响应（只能证明端口有人听）`
              : '浏览器探测：超时或未探测'
      const 依据 = 错误 ? `${探测依据}；用量错误：${错误.slice(0, 160)}` : 探测依据
      const 探测目标 = (连通 && 连通.target) || 'https://chatgpt.com/'

      const 结果 = (code, 标题, 说明, 建议, 色, 底) => ({
        code,
        标题,
        说明,
        建议,
        色,
        底,
        代理可达,
        桥在,
        链路通,
        链路来源,
        依据,
        连通毫秒: (连通 && 连通.ms) ?? null,
      })

      /** 「代理开着，但没连出去」= 主场景。宿主探测和旧宿主的用量错误推断共用这一套文案。 */
      const 隧道不通 = (前缀 = '') =>
        结果(
          'tunnel-down',
          '代理开着，但没连出去',
          前缀 +
            `本机代理 ${代理名} 在答话（端口是通的），但经它访问 ${探测目标} 在 ${((连通 && 连通.timeoutMs) || 3000) / 1000} 秒内没有成功：也就是说 Clash / VPN 开着，开关却没真的连出去。` +
            '最常见的原因：开关没打开、选中的节点没连上、或者分流规则还没就绪。' +
            (连通 && 连通.reason ? `本次探测结果：${连通.reason}` : '') +
            (错误 ? `（用量错误：${错误.slice(0, 120)}）` : ''),
          '打开 Clash / VPN 的面板，把开关拨到「开启 / 已连接」——Clash for Windows 在 General 页的「System Proxy」，或托盘菜单里的「开启系统代理」；顺便确认选中的节点有延迟。' +
            '等 2–3 秒后点这里的「重新检测」，本页每 5 秒也会自动重测。' +
            (!桥在 && !桥正启 ? ` 另外本地桥 127.0.0.1:${端口} 也没在运行，链路恢复后再点「重启代理」。` : ''),
          '#c98a00',
          'rgba(201,138,0,.08)',
        )

      // 1) 刚拿到用量 = 整条链路都通过，这是最硬的证据，优先于任何探测
      if (新鲜 && 桥在) return { code: 'ok', 代理可达, 桥在, 链路通, 链路来源, 依据, 连通毫秒: (连通 && 连通.ms) ?? null }
      if (新鲜 && !桥在) {
        return 结果(
          'bridge-off',
          '本地代理桥未运行',
          `用量是刚刚取到的（代理与上游都通），但 127.0.0.1:${端口} 上没有可用的 codex-bridge（宿主状态：${状态文}）。DSH 的 ChatGPT 请求靠这个本地桥转发，桥不在就会报 Connection error。`,
          配置.autoStart === false
            ? '自动启动已关闭；点「重启代理」可以手动把桥拉起来。'
            : '点「重启代理」让插件重新拉起；如果 8787 被别的服务占着，先处理占用进程（插件不会抢端口）。',
          '#c98a00',
          'rgba(201,138,0,.08)',
        )
      }

      // 2) 代理明确没开：宿主探测连 7890 都连不上（旧宿主退回浏览器探测的「连接被拒绝」）
      if ((宿主探测在 && 连通.state === 'proxy-down') || (!宿主探测在 && 代理.configured && 代理可达 === false)) {
        return 结果(
          'proxy-off',
          '代理未开（Clash / VPN 没启动）',
          `本机代理 ${代理名} 连不上${宿主探测在 && 连通.reason ? `（${连通.reason}）` : ''}。ChatGPT 必须走代理：chatgpt.com 的 DNS 已被污染（实测会解析到 43.226.16.8），直连大约 10 秒后超时，DSH 就会报 Connection error。`,
          `先启动 Clash / VPN，确认 ${代理名} 恢复；本页每 5 秒自动重测，也可以点「重新检测」。` +
            (!桥在 && !桥正启 ? ` 另外本地桥（127.0.0.1:${端口}）也没在运行，代理恢复后再点「重启代理」。` : ''),
          '#c0392b',
          'rgba(192,57,43,.08)',
        )
      }

      // 3) 代理在、但没连出去 —— 用户最常见的「开关没拨开」
      if (宿主探测在 && 连通.state === 'tunnel-down') return 隧道不通()

      // 4) 桥不在：代理就算通也转发不了
      if (!桥在) {
        if (桥正启) {
          return 结果(
            'bridge-starting',
            '本地代理桥正在启动…',
            `127.0.0.1:${端口} 上的 bridge 还在启动 / 探测（${状态文}）。等几秒；如果一直停在这里，看下面「插件日志」。`,
            '',
            '#c98a00',
            'rgba(201,138,0,.08)',
          )
        }
        return 结果(
          'bridge-off',
          '本地代理桥未运行',
          (代理可达 === true ? `本机代理 ${代理名} 与上游是通的，但 ` : '') +
            `127.0.0.1:${端口} 上没有可用的 codex-bridge（宿主状态：${状态文}）。DSH 的 ChatGPT 请求靠这个本地桥转发，桥不在就会直接报 Connection error。`,
          (配置.autoStart === false
            ? '自动启动已关闭；点「重启代理」可以手动把桥拉起来。'
            : '点「重启代理」让插件重新拉起；如果 8787 被别的服务占着，先处理占用进程（插件不会抢端口）。') +
            (侧车.lastError ? ` 宿主记录：${String(侧车.lastError).slice(0, 180)}` : ''),
          '#c98a00',
          'rgba(201,138,0,.08)',
        )
      }

      // 5) 桥在，但没配代理
      if (!代理.configured && 错误) {
        return 结果(
          'no-proxy',
          '没有配置本机代理',
          '代理设置是空的。ChatGPT 必须走代理，直连会被 DNS 污染卡死（大约 10 秒后超时）。',
          '在下面「代理设置」里填 http://127.0.0.1:7890，保存后再点「重新检测」。',
          '#c0392b',
          'rgba(192,57,43,.08)',
        )
      }

      // 6) 链路已经证明通，但额度在网络层失败（桥自己的出口 / 上游临时抽风）
      if (网络错 && 链路通 === true) {
        return 结果(
          'usage-fail',
          '能连到 ChatGPT，但额度读取失败',
          `${连通短句(连通)}；这次是读取额度这一步失败的：${错误.slice(0, 200)}`,
          '点下面的「刷新用量」重试一次；如果一直失败，看「插件日志」里 bridge 的报错（token 过期的话重新登录一次）。',
          '#c98a00',
          'rgba(201,138,0,.08)',
        )
      }

      // 7) 旧宿主（没有穿透探测）兜底：端口有响应但用量网络层失败 = 同一个「没连出去」
      if (网络错) {
        if (代理可达 === true) return 隧道不通('（旧宿主没有穿透探测，这条是从用量错误推断的。）')
        return 结果(
          'proxy-off',
          '代理未开（Clash / VPN 没启动）',
          `本机代理 ${代理名} 连不上。ChatGPT 必须走代理：chatgpt.com 的 DNS 已被污染（实测会解析到 43.226.16.8），直连大约 10 秒后超时，DSH 就会报 Connection error。`,
          `先启动 Clash / VPN，确认 ${代理名} 恢复；本页每 5 秒自动重测，也可以点「重新检测」。`,
          '#c0392b',
          'rgba(192,57,43,.08)',
        )
      }

      return { code: 'ok', 代理可达, 桥在, 链路通, 链路来源, 依据, 连通毫秒: (连通 && 连通.ms) ?? null }
    }

    // ---------- 调用探活（主灯） ----------
    //
    // 宿主 /state 里的 canary 是「一次真实模型调用」的缓存结果：
    //   · 它回答用户唯一关心的问题——现在能不能调用 GPT；
    //   · 端口 / 隧道探测降级成它下面的一行小字（链路详情）；
    //   · 旧宿主没有 canary 字段时，退回上面的 诊断（端口 / 隧道）并提示重启。

    const 毫秒文 = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return '—'
      return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)}s`
    }

    /** 「最近测试」的时间说法：几十秒不吓人，几个小时也别显示成 10800 秒。 */
    const 时长文 = (秒) => {
      const n = Number(秒)
      if (!Number.isFinite(n) || n < 0) return ''
      const s = Math.round(n)
      if (s < 60) return `${s} 秒前`
      if (s < 3600) return `${Math.round(s / 60)} 分钟前`
      if (s < 86400) {
        const 时 = s / 3600
        return `${Number.isInteger(时) ? 时 : 时.toFixed(1)} 小时前`
      }
      return `${Math.round(s / 86400)} 天前`
    }

    /**
     * 绿灯过期判据：超过「自动测试间隔 + 60 秒容差」还挂着的结果只能算「上次测试」，
     * 不能当成此刻的结论（关页一整晚再打开也一样）。阈值由自动测试间隔推导，不写死。
     */
    const 探活已过期 = (canary) => {
      if (!canary) return false
      if (canary.ageSeconds === null || canary.ageSeconds === undefined) return false
      return Number(canary.ageSeconds) > 探活过期秒
    }

    const 探活样式 = {
      ok: { 色: '#2e9e5b', 底: 'rgba(46,158,91,.08)' },
      'token-invalid': { 色: '#c0392b', 底: 'rgba(192,57,43,.08)' },
      forbidden: { 色: '#c0392b', 底: 'rgba(192,57,43,.08)' },
      quota: { 色: '#c98a00', 底: 'rgba(201,138,0,.08)' },
      network: { 色: '#c0392b', 底: 'rgba(192,57,43,.08)' },
      'bridge-down': { 色: '#c98a00', 底: 'rgba(201,138,0,.08)' },
      upstream: { 色: '#c98a00', 底: 'rgba(201,138,0,.08)' },
      'bad-request': { 色: '#c98a00', 底: 'rgba(201,138,0,.08)' },
      error: { 色: '#c98a00', 底: 'rgba(201,138,0,.08)' },
      probing: { 色: '#c98a00', 底: 'rgba(201,138,0,.08)' },
      idle: { 色: '#888', 底: 'transparent' },
    }

    const 探活原因 = (canary) => {
      switch (canary && canary.state) {
        case 'token-invalid':
          return 'token 失效'
        case 'forbidden':
          return '账号没有权限（403）'
        case 'quota': {
          const 判 = canary && canary.quota && canary.quota.verdict
          if (判 === 'primary') return '5 小时窗口用满'
          if (判 === 'secondary') return '周额度耗尽'
          if (判 === 'not-full') return '上游 429（额度窗口并未满）'
          return '额度用尽'
        }
        case 'network':
          return canary.timeout ? '网络 / 代理不通（超时）' : '网络 / 代理不通'
        case 'bridge-down':
          return '本地桥未运行'
        case 'upstream':
          return '上游 5xx'
        case 'bad-request':
          return '上游拒绝了这次请求'
        case 'error':
          return '探活出错'
        default:
          return '未知原因'
      }
    }

    /** 429 诊断的「数据有多新」：usageAgeSeconds / usageStale 由宿主现场拉用量时写入。 */
    const 额度数据文 = (q) => {
      const 秒 = q && q.usageAgeSeconds
      if (秒 === null || 秒 === undefined || !Number.isFinite(Number(秒))) return ''
      const 旧 = q.usageStale ? '，最近一次刷新失败、可能不是最新' : ''
      return `（额度数据 ${时长文(秒)}${旧}）`
    }

    /**
     * 429 的窗口明细：把「5 小时窗口用满（等一会儿就回来）」和
     * 「7 天窗口耗尽（这轮额度真用完了）」分开说，顺手给出重置倒计时。
     * 判满阈值是 ≥95%（不是老代码的 99.5%），和宿主 额度满阈值 保持一致。
     */
    const 额度诊断文 = (q) => {
      const 剩 = (窗口) => (窗口 && 窗口.resetAfterSeconds ? `约 ${倒计时(窗口, null)} 后重置` : '重置时间未知')
      const p = q && q.primary
      const s = q && q.secondary
      const 数据 = 额度数据文(q)
      if (q && q.verdict === 'primary') {
        return `5 小时窗口已用 ${p ? 百分比(p.usedPercent) : '未知'}${s ? `（周窗口 ${百分比(s.usedPercent)}）` : ''}，${剩(p)}。订阅本身没坏，等窗口重置就能继续调用。${数据}`
      }
      if (q && q.verdict === 'secondary') {
        return `7 天窗口已用 ${s ? 百分比(s.usedPercent) : '未知'}：这轮订阅的额度真的用完了，${剩(s)}；5 小时窗口 ${p ? 百分比(p.usedPercent) : '未知'}。${数据}`
      }
      if (q && q.verdict === 'not-full') {
        const 前缀 = q.upstreamLimited ? '上游已明确限流（allowed=false / limitReached=true），但' : '上游 429，但'
        return `${前缀}5 小时窗口 ${p ? 百分比(p.usedPercent) : '未知'}、7 天窗口 ${s ? 百分比(s.usedPercent) : '未知'} 都不到 95%——可能是账号级限制、共享账号被限速，或上游临时风控。${数据}`
      }
      return `还没读到额度窗口数据，暂时分不清是「5 小时窗口用满」还是「周额度耗尽」；点上面的「刷新用量」再试一次。${数据}`
    }

    const 探活标题 = (canary) => {
      if (!canary) return ''
      const 旧 = 探活已过期(canary)
      if (canary.state === 'ok') {
        const 主体 = `${canary.model || '模型'} · ${毫秒文(canary.ms)}`
        return 旧
          ? `上次测试（${时长文(canary.ageSeconds)}）可以调用 GPT（${主体}）——结果可能已过期`
          : `现在可以调用 GPT（${主体}）`
      }
      if (canary.state === 'idle') return '还没有测试过能不能调用 GPT'
      if (canary.state === 'probing') return '正在测试能不能调用 GPT…'
      if (旧) return `上次测试（${时长文(canary.ageSeconds)}）时还不能调用 GPT：${探活原因(canary)}`
      return `现在不能调用 GPT：${探活原因(canary)}`
    }

    /** 旧的端口 / 隧道探测：现在只做主灯下面的一行小字。 */
    const 链路详情文 = (态, 诊, 代理, 侧车) => {
      const 连通 = 态 && 态.connectivity
      const 代理名 = 代理 && 代理.configured ? 代理地址(代理) : '（未配置）'
      const 代理文 =
        !代理 || !代理.configured
          ? '代理未配置'
          : 诊 && 诊.代理可达 === true
            ? `代理 ${代理名} 有响应`
            : 诊 && 诊.代理可达 === false
              ? `代理 ${代理名} 连不上`
              : `代理 ${代理名} 探测中`
      const 隧道文 = !连通
        ? '隧道未探测'
        : 连通.state === 'ok'
          ? '隧道 TLS 通过'
          : 连通.state === 'tunnel-down'
            ? '隧道 TLS 没通过'
            : 连通.state === 'proxy-down'
              ? '隧道没建立'
              : 连通.state === 'disabled'
                ? '没有代理可探'
                : '隧道探测中'
      const 桥文 = !侧车
        ? '桥状态未知'
        : 侧车.status === 'running'
          ? '桥运行中（插件托管）'
          : 侧车.status === 'reused'
            ? '桥运行中（复用外部）'
            : `桥${(状态表[侧车.status] && 状态表[侧车.status].文) || 侧车.status || '未知'}`
      return `${代理文} · ${隧道文} · ${桥文}`
    }

    /**
     * 主灯：
     *   ✅ 现在可以调用 GPT（gpt-6-sol · 1.6s）
     *   ❌ 现在不能调用 GPT：token 失效 / 额度用尽 / 网络或代理不通 / 桥未运行 / 上游 5xx
     * 下面的小字才是代理端口与 TLS 隧道，避免两个判据打架。
     */
    const 探活条 = (态, 诊, 代理, 侧车, 立即测试, 测试中) => {
      const canary = 态 && 态.canary

      // 旧宿主（还没重启）：保留原来的链路诊断，并明确说清主灯还没换。
      if (!canary) {
        return h(
          React.Fragment,
          null,
          诊断条(诊, 代理, 侧车, 立即测试),
          h(
            'div',
            { style: { ...S.dim, margin: '-4px 0 10px' } },
            `宿主还是旧版（没有 /canary 路由）：主灯暂时仍是端口 / 隧道探测。重启 DSH 后，这里会改成「每 ${自动测试间隔分钟} 分钟最多一次真实调用」的结论。`,
          ),
        )
      }

      const 风 = 探活样式[canary.state] || 探活样式.error
      const 详情 = 链路详情文(态, 诊, 代理, 侧车)
      const 旧 = 探活已过期(canary)
      const 时间 = canary.at
        ? `最近测试：${canary.ageSeconds !== null && canary.ageSeconds !== undefined ? 时长文(canary.ageSeconds) : 时刻(new Date(canary.at).toISOString())}`
        : ''
      const 用量文 = canary.state === 'ok' && canary.totalTokens ? `${canary.totalTokens} tokens · ` : ''
      const 缓存文 = `真实调用结果缓存 ${canary.cacheSeconds || 60} 秒（60 秒内连点不会重复打上游）；自动测试每 ${自动测试间隔分钟} 分钟最多一次，页面隐藏时暂停；这条结论只代表「${canary.model || '探活模型'}」这一个模型，不替其它模型作保`
      const 费用提示 = () =>
        h(
          'div',
          { style: { ...S.dim, marginTop: 1, opacity: 0.55 } },
          `此测试会真实调用一次模型，消耗极少量额度（实测约 22 tokens，按几百 token 上限估算），每 ${自动测试间隔分钟} 分钟最多一次。`,
        )
      const 按钮 = (颜色) =>
        h(
          'button',
          {
            type: 'button',
            style: { ...S.btn, borderColor: 颜色, color: 颜色, padding: '2px 10px', fontSize: 11.5 },
            disabled: 测试中,
            onClick: 立即测试,
            title: '经本地桥发一次极小的真实请求，确认现在能不能调用 GPT；60 秒内重复点击会复用缓存，不重复消耗额度',
          },
          测试中 ? '测试中…' : '立即测试',
        )

      if (canary.state === 'ok') {
        const 绿 = 旧 ? '#7d9b8a' : '#2e9e5b'
        return h(
          'div',
          { style: { margin: '0 0 10px' } },
          h(
            'div',
            { style: { ...S.row, gap: 8, fontSize: 13 } },
            h('span', { style: S.圆点(绿) }),
            h('span', { style: { fontWeight: 700 } }, 探活标题(canary)),
            h('span', { style: S.dim }, `${用量文}${时间}`),
            h('div', { style: { flex: 1 } }),
            按钮(绿),
          ),
          旧
            ? h(
                'div',
                { style: { ...S.dim, marginTop: 3, color: '#c98a00' } },
                `这条结论是 ${时长文(canary.ageSeconds)}的，不能当成此刻也能调用；页面打开后会重新测一次（每 ${自动测试间隔分钟} 分钟最多一次）。`,
              )
            : null,
          h('div', { style: { ...S.dim, marginTop: 3 } }, 详情),
          h('div', { style: { ...S.dim, marginTop: 1, opacity: 0.55 } }, 缓存文),
          费用提示(),
        )
      }

      if (canary.state === 'idle' || canary.state === 'probing') {
        return h(
          'div',
          { style: { ...S.提示('#888'), marginBottom: 10 } },
          h(
            'div',
            { style: { ...S.row, gap: 8, fontWeight: 700 } },
            h('span', { style: S.圆点('#c98a00') }),
            h('span', null, canary.probing || canary.state === 'probing' ? '正在测试能不能调用 GPT…' : '还没有测试过能不能调用 GPT'),
            h('div', { style: { flex: 1 } }),
            按钮('#c98a00'),
          ),
          h('div', { style: { ...S.dim, marginTop: 3 } }, 详情),
          费用提示(),
        )
      }

      return h(
        'div',
        {
          style: {
            border: `1px solid ${风.色}`,
            background: 风.底,
            borderRadius: 10,
            padding: '10px 12px',
            margin: '0 0 10px',
            color: 风.色,
          },
        },
        h(
          'div',
          { style: { ...S.row, gap: 8, fontWeight: 700, fontSize: 14, lineHeight: 1.45 } },
          h('span', { style: S.圆点(风.色) }),
          h('span', null, 探活标题(canary)),
          h(
            'span',
            { style: { ...S.dim, color: 风.色, opacity: 0.72, fontWeight: 400 } },
            `${时间}${旧 ? ' · 结果已过期' : ''}${测试中 ? ' · 正在重新测试…' : ''}`,
          ),
          h('div', { style: { flex: 1 } }),
          按钮(风.色),
        ),
        canary.reason ? h('div', { style: { fontSize: 12, lineHeight: 1.75, marginTop: 5, color: 'inherit' } }, canary.reason) : null,
        canary.state === 'quota'
          ? h('div', { style: { fontSize: 12, lineHeight: 1.75, marginTop: 4, color: 'inherit' } }, 额度诊断文(canary.quota))
          : null,
        canary.suggestion ? h('div', { style: { fontSize: 12, lineHeight: 1.75, marginTop: 2, color: 'inherit' } }, canary.suggestion) : null,
        h('div', { style: { ...S.dim, color: 风.色, opacity: 0.7, marginTop: 4 } }, 详情),
        h('div', { style: { ...S.dim, color: 风.色, opacity: 0.55, marginTop: 1 } }, 缓存文),
        费用提示(),
      )
    }

    // ---------- 小控件 ----------

    const 标签 = (文, 值) =>
      h('div', { style: { marginBottom: 6 } }, h('div', { style: S.科目标签 }, 文), h('div', { style: { fontSize: 13 } }, 值))

    const 额度块 = (窗口, 抓取时间, 兜底标题) => {
      const 标题 = 窗口 ? 窗口名(窗口.windowSeconds) : 兜底标题
      if (!窗口) {
        return h('div', { style: S.card }, h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 标题), h('div', { style: S.dim }, '上游没有返回这个窗口的数据。'))
      }
      const 已用 = 窗口.usedPercent
      const 剩 = 窗口.remainingPercent
      return h(
        'div',
        { style: S.card },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: { fontWeight: 600 } }, 标题),
          h('div', { style: S.dim }, `已用 ${百分比(已用)}`),
        ),
        h('div', { style: { ...S.row, alignItems: 'baseline', gap: 8, marginTop: 4 } },
          h('div', { style: { ...S.数字, color: 进度色(已用) } }, 百分比(已用)),
          h('div', { style: S.dim }, '已用'),
          h('div', { style: { flex: 1 } }),
          h('div', { style: { ...S.数字, fontSize: 20 } }, 百分比(剩)),
          h('div', { style: S.dim }, '剩余'),
        ),
        h('div', { style: S.bar },
          h('div', {
            style: {
              height: '100%',
              width: `${Math.max(1, Math.min(100, Number(已用) || 0))}%`,
              background: 进度色(已用),
              transition: 'width .4s ease',
            },
          }),
        ),
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.dim }, `重置倒计时：${倒计时(窗口, 抓取时间)}`),
          Number.isFinite(Number(窗口.resetAt)) ? h('div', { style: S.dim }, `重置于 ${时刻(new Date(Number(窗口.resetAt) * 1000).toISOString())}`) : null,
        ),
      )
    }

    /**
     * 顶部诊断条：
     *   ok 的时候只留一行淡淡的绿字（正常看额度）；
     *   代理 / 桥 / 上游出问题时用整块醒目提示，红色留给「代理未开」。
     */
    const 诊断条 = (诊, 代理, 侧车, 重测) => {
      if (!诊) return null
      if (诊.code === 'ok') {
        const 代理文 =
          代理 && 代理.configured
            ? `${代理地址(代理)} ${
                诊.链路来源 === 'probe'
                  ? `穿透探测通过${诊.连通毫秒 !== null && 诊.连通毫秒 !== undefined ? `（${诊.连通毫秒} ms）` : ''}`
                  : 诊.链路通 === true
                    ? '用量刚刚验证过（代理与上游都通）'
                    : 诊.代理可达 === true
                      ? '有响应'
                      : '检测中…'
              }`
            : '未配置'
        const 桥文 = 侧车.status === 'reused' ? '本地桥运行中（复用）' : '本地桥运行中'
        return h('div', { style: { ...S.row, gap: 8, margin: '0 0 10px', fontSize: 12, opacity: 0.85 } },
          h('span', { style: S.圆点('#2e9e5b') }),
          h('span', null, `链路诊断：代理 ${代理文}　·　${桥文}`),
          h('button', { type: 'button', style: { ...S.btn, padding: '1px 8px', fontSize: 11 }, onClick: 重测, title: '经代理重新探测一次 ChatGPT' }, '重新检测'),
        )
      }
      return h('div', {
        style: {
          border: `1px solid ${诊.色}`,
          background: 诊.底,
          borderRadius: 10,
          padding: '10px 12px',
          margin: '0 0 10px',
          color: 诊.色,
        },
      },
        h('div', { style: { ...S.row, gap: 8, fontWeight: 700, fontSize: 14, lineHeight: 1.45 } },
          h('span', { style: S.圆点(诊.色) }),
          h('span', null, 诊.标题),
        ),
        h('div', { style: { fontSize: 12, lineHeight: 1.75, marginTop: 5, color: 'inherit' } }, 诊.说明),
        诊.建议 ? h('div', { style: { fontSize: 12, lineHeight: 1.75, marginTop: 2, color: 'inherit' } }, 诊.建议) : null,
        h('div', { style: { ...S.row, gap: 10, alignItems: 'center', marginTop: 7 } },
          h('button', { type: 'button', style: { ...S.btn, borderColor: 诊.色, color: 诊.色 }, onClick: 重测 }, '重新检测'),
          h('span', { style: { ...S.dim, color: 诊.色, opacity: 0.72, wordBreak: 'break-all' } }, 诊.依据),
        ),
      )
    }

    // ---------- 设置页 ----------

    function Section() {
      const [态, 设态] = React.useState(null)
      const [草稿, 设草稿] = React.useState(null)
      const [说, 设说] = React.useState('')
      const [忙, 设忙] = React.useState(false)
      const [探测版, 设探测版] = React.useState(0)
      const [探活测试中, 设探活测试中] = React.useState(false)
      const [可见版, 设可见版] = React.useState(0)

      const 拉 = React.useCallback(async () => {
        const r = await get('/state')
        if (r && r.ok) 设态(r)
        else 设说('读不到宿主那边的状态（插件加载了吗？）')
      }, [])

      React.useEffect(() => {
        void 拉()
        const t = setInterval(() => void 拉(), 5000)
        return () => clearInterval(t)
      }, [拉])

      // 代理探测：页面加载后探一次，之后缓存过期（5 秒）再探；探测结果变化时重渲染。
      // 放在早退之前，钩子顺序保持稳定。
      const 代理 = 解析代理(态 && 态.config && 态.config.proxy)
      React.useEffect(() => {
        if (!页面可探测本机 || !代理 || !代理.configured || !代理.http) return
        if (取探测(代理) !== undefined) return
        let 活 = true
        void 确保探测(代理).then(() => {
          if (活) 设探测版((旧) => 旧 + 1)
        })
        return () => {
          活 = false
        }
      }, [态, 探测版])

      // 真实调用探活：页面打开时跑一次，之后每 5 分钟最多一次；
      // 页面隐藏 / 关闭时完全停表，不在后台偷偷消耗额度。
      // 宿主自己缓存 60 秒，且「立即测试」60 秒内也会回到缓存，不会连点重复打上游。
      const 跑探活 = React.useCallback(async (force) => {
        if (force) 设探活测试中(true)
        try {
          const r = force ? await post('/canary', { force: true }) : await get('/canary')
          if (r && r.ok && r.canary) {
            设态((旧) => (旧 ? { ...旧, canary: r.canary } : 旧))
            // 首次进页面时 态 可能还是 null（/state 比 canary 慢），立刻补拉一次，
            // 免得主灯要等下一个 5 秒轮询才出现。这里不会再打真实调用（canary 已缓存）。
            void 拉()
          } else if (force) 设说('探活接口不可用：宿主可能还是旧版，重启 DSH 后再试。')
        } finally {
          if (force) 设探活测试中(false)
        }
      }, [拉])

      React.useEffect(() => {
        let 表 = null
        let 上次自动 = 0
        let 首次已跑 = false
        const 停表 = () => {
          if (表 !== null) {
            clearInterval(表)
            表 = null
          }
        }
        const 自动跑 = () => {
          if (!页面当前可见()) return
          上次自动 = Date.now()
          void 跑探活(false)
        }
        const 起表 = () => {
          if (表 !== null || !页面当前可见()) return
          表 = setInterval(自动跑, 自动测试间隔毫秒)
        }
        const 变 = () => {
          if (!页面当前可见()) {
            停表()
            return
          }
          设可见版((旧) => 旧 + 1)
          // 从隐藏切回可见：超过自动测试间隔就补一次，否则只恢复计时。
          if (!首次已跑 || Date.now() - 上次自动 >= 自动测试间隔毫秒) {
            首次已跑 = true
            自动跑()
          }
          起表()
        }
        if (页面当前可见()) {
          首次已跑 = true
          自动跑()
        }
        起表()
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', 变)
        }
        return () => {
          停表()
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', 变)
          }
        }
      }, [跑探活, 设可见版])

      // DSH 刚重启时 bridge 可能还在启动：探活会先撞上 ECONNREFUSED。
      // 这种失败没有打到模型、不花额度，5 秒后自动重试一次（走 bridge-down 例外）；
      // 桥一起来就恢复成「可以调用」，不会让主灯红着卡满一分钟。页面隐藏时不重试，
      // 切回可见时用「可见版」重新触发一次检查。
      const 探活状态 = 态 && 态.canary ? 态.canary.state : null
      const 探活时间 = 态 && 态.canary ? 态.canary.at : null
      const 探活代码 = 态 && 态.canary ? 态.canary.code : null
      React.useEffect(() => {
        // 只对「端口根本没人听」做 5 秒快重试；端口被别的服务占着时不要每 5 秒去敲它。
        if (!页面当前可见() || 探活状态 !== 'bridge-down' || 探活代码 !== 'ECONNREFUSED') return
        const t = setTimeout(() => {
          if (页面当前可见()) void 跑探活(true)
        }, 5000)
        return () => clearTimeout(t)
      }, [探活状态, 探活时间, 探活代码, 可见版, 跑探活])

      if (!态) {
        return h('div', { style: S.wrap }, h('div', { style: S.h, marginTop: 0 }, '订阅服务 / 用量'), h('div', { style: S.dim }, '读取中…'))
      }

      const 配置 = { ...态.config, ...(草稿 || {}) }
      const 侧车 = 态.sidecar || {}
      const 用量 = 态.usage || {}
      const 数据 = 用量.data || null
      const 账号 = (数据 && 数据.account) || {}
      const 额度 = (数据 && 数据.rateLimit) || {}
      const 统计 = 态.stats || { today: {}, total: {}, recent: [] }
      const token = 态.tokens || {}
      const 状态信息 = 状态表[侧车.status] || { 文: 侧车.status || '未知', 色: '#888' }
      const 改 = (k, v) => 设草稿((旧) => ({ ...(旧 || {}), [k]: v }))

      const 探测值 = 页面可探测本机 && 代理.configured && 代理.http ? 取探测(代理) : null
      const 诊 = 诊断(态, 探测值)
      const 重测 = () => {
        探测缓存.at = 0
        设探测版((旧) => 旧 + 1)
        // 让宿主立刻重探一次（旧宿主没有 /probe 路由，静默失败就行）
        void post('/probe', { force: true })
          .then((r) => {
            if (r && r.ok && r.connectivity) 设态((旧) => (旧 ? { ...旧, connectivity: r.connectivity } : 旧))
            设探测版((旧) => 旧 + 1)
            return 拉()
          })
          .catch(() => {})
      }

      const 测调用 = () => {
        void 跑探活(true)
      }

      const 存 = async () => {
        if (!草稿) return
        设忙(true)
        const r = await post('/save', 草稿)
        设忙(false)
        if (r && r.ok) {
          设态(r)
          设草稿(null)
          设说(r.说 || '保存好了')
        } else 设说((r && r.说) || '保存失败')
      }

      const 重启 = async () => {
        设忙(true)
        const r = await post('/restart', {})
        设忙(false)
        if (r && r.ok) {
          设态(r)
          设说(r.说 || '已重启')
        } else 设说((r && r.说) || '重启失败')
      }

      const 刷新用量 = async () => {
        设忙(true)
        探测缓存.at = 0
        const r = await post('/usage', { force: true })
        设忙(false)
        if (r && r.ok) {
          设说(r.stale ? `用量刷新失败：${r.error || '未知错误'}（下面是上一次的数据）` : r.source === 'bridge' ? '用量已从 bridge 刷新。' : '用量已从上游直连刷新。')
          await 拉()
        } else 设说((r && r.error) || '刷新用量失败')
        设探测版((旧) => 旧 + 1)
      }

      const 今日 = 统计.today || {}
      const 模型们 = Object.entries(今日.models || {}).sort((a, b) => b[1] - a[1])
      const 缓存秒 = Number(用量.cacheSeconds) || 60

      return h(
        'div',
        { style: S.wrap },

        // —— 标题 + 状态 ——
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: { ...S.h, margin: 0 } }, '订阅服务 / 用量'),
          h('div', { style: S.角标 },
            h('span', { style: S.圆点(状态信息.色) }),
            h('span', null, 状态信息.文),
            侧车.pid ? h('span', { style: S.dim }, `pid ${侧车.pid}`) : null,
          ),
        ),
        h('div', { style: { ...S.dim, margin: '4px 0 10px' } }, `插件 v${态.version || '?'}　·　端口 ${配置.port}　·　${侧车.managed ? '由插件托管，DSH 退出时一起回收' : 侧车.status === 'reused' ? '外部进程，插件只复用不接管' : '未托管'}`),

        // —— 主灯：现在能不能真的调用 GPT（旧宿主退回链路诊断） ——
        探活条(态, 诊, 代理, 侧车, 态.canary ? 测调用 : 重测, 探活测试中),

        // —— 公告栏 ——
        侧车.status === 'reused'
          ? h('div', { style: S.提示('#c98a00') },
              `端口 ${配置.port} 上已经有一个 codex-bridge 在跑（pid ${侧车.pid ?? '?'}），插件直接复用它、没有抢端口。` +
                (侧车.hasUsageRoute ? '这个 bridge 有 /v1/usage，用量就从它读。' : '这个 bridge 是旧版（没有 /v1/usage），用量已改成直连上游只读探测。重启 DSH 前如果想让插件自己管，先关掉那个外部进程。'),
            )
          : null,
        侧车.status === 'conflict'
          ? h('div', { style: S.提示('#c0392b') }, 侧车.lastError || '端口被别的服务占用，按规矩不抢端口。')
          : null,
        侧车.status === 'error'
          ? h('div', { style: S.提示('#c0392b') }, 侧车.lastError || '代理没有跑起来，看下面日志。')
          : null,
        侧车.status === 'starting'
          ? h('div', { style: S.提示('#c98a00') }, 侧车.lastError || 'bridge 正在启动，等几秒刷新。')
          : null,
        token.exists === false
          ? h('div', { style: S.提示('#c0392b') }, `凭据文件不存在：${token.file}。先去 codex-bridge 目录跑 login.mjs 完成 ChatGPT 登录。`)
          : null,
        token.expired === true
          ? h('div', { style: S.提示('#c98a00') }, 'access_token 已过期；bridge 会在下一次请求时自动刷新，额度数据可能暂时读不到。')
          : null,

        // —— 账号 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'ChatGPT 账号'),
          h('div', { style: S.grid },
            标签('邮箱', 账号.email || (token.exists ? '（上游没返回，可能是旧 bridge）' : '—')),
            标签('套餐', 账号.planType ? String(账号.planType).toUpperCase() : '—'),
            标签('账号 ID', h('span', { style: S.mono }, 账号.accountId || token.accountId || '—')),
            标签('token 有效期', token.expiresAt ? `${时刻(new Date(token.expiresAt).toISOString())}${token.expired ? '（已过期）' : ''}` : '—'),
          ),
        ),

        // —— 额度 ——
        h('div', { style: S.h }, '额度',
          h('span', { style: { ...S.dim, fontWeight: 400, marginLeft: 8 } },
            用量.error
              ? `读取失败：${用量.error}`
              : 数据
                ? `更新于 ${时刻(数据.fetchedAt)}（缓存 ${缓存秒} 秒${用量.source === 'direct' ? '，直连上游' : ''}）`
                : '还没有拿到额度',
          ),
        ),
        数据 && 数据.fetchedAt && 用量.stale ? h('div', { style: S.提示('#c98a00') }, `最近一次刷新失败：${用量.error || '未知错误'}；下面是上一次的数据。`) : null,
        h('div', { style: S.grid },
          额度块(额度.primary, 数据 && 数据.fetchedAt, '5 小时窗口'),
          额度块(额度.secondary, 数据 && 数据.fetchedAt, '7 天窗口'),
        ),
        h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: -2 } },
          h('div', { style: S.dim },
            额度.limitReached
              ? '⚠ 上游显示额度已用尽（limit_reached）。'
              : `可用重置券 ${数据 && 数据.resetCredits ? 数字(数据.resetCredits.availableCount) : '—'} 张` +
                (数据 && 数据.credits ? `　·　额外额度 ${数据.credits.unlimited ? '无限' : 数据.credits.hasCredits ? 数据.credits.balance : '无'}` : ''),
          ),
          h('button', { type: 'button', style: S.btn, disabled: 忙, onClick: 刷新用量 }, '刷新用量'),
        ),

        // —— 本地流量 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '本地流量（今日）',
            h('span', { style: { ...S.dim, fontWeight: 400, marginLeft: 8 } }, 统计.logFile ? `日志：${统计.logFile}` : '还没有日志'),
          ),
          h('div', { style: S.grid },
            标签('请求数', 数字(今日.requests)),
            标签('成功 / 失败', `${数字(今日.ok)} / ${数字(今日.errors)}`),
            标签('平均耗时', 今日.avgMs !== null && 今日.avgMs !== undefined ? `${数字(今日.avgMs)} ms` : '—'),
            标签('输入条目合计', 数字(今日.inputItems)),
          ),
          模型们.length > 0
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: S.科目标签 }, '按模型'),
                模型们.slice(0, 6).map(([m, n]) => h('span', { key: m, style: S.tag }, `${m} × ${n}`)),
              )
            : h('div', { style: { ...S.dim, marginTop: 8 } }, '今天还没有经过这个 bridge 的请求。'),
          (统计.recent || []).length > 0
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: S.科目标签 }, '最近几条'),
                (统计.recent || []).slice(0, 6).map((r, i) =>
                  h('div', { key: i, style: S.最近行 },
                    `${r.t ? 时刻(r.t) : '—'}　${r.ok ? '✓' : '✗'}　${r.model || '?'}　${r.ms !== null && r.ms !== undefined ? `${r.ms} ms` : ''}${r.status ? `　HTTP ${r.status}` : ''}`,
                  ),
                ),
              )
            : null,
        ),

        // —— 设置 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '代理设置'),
          h('div', { style: S.grid },
            h('label', null,
              h('div', { style: S.科目标签 }, '端口'),
              h('input', { type: 'number', style: S.input, value: 配置.port, onChange: (e) => 改('port', e.target.value) }),
            ),
            h('label', null,
              h('div', { style: S.科目标签 }, '本机代理（出网用）'),
              h('input', { type: 'text', style: S.input, value: 配置.proxy, placeholder: 'http://127.0.0.1:7890，留空=不走代理', onChange: (e) => 改('proxy', e.target.value) }),
            ),
            h('label', null,
              h('div', { style: S.科目标签 }, '用量缓存秒数'),
              h('input', { type: 'number', style: S.input, value: 配置.usageCacheSeconds, min: 15, max: 600, onChange: (e) => 改('usageCacheSeconds', e.target.value) }),
            ),
            h('label', null,
              h('div', { style: S.科目标签 }, '探活模型（真实调用一次）'),
              h('input', { type: 'text', style: S.input, value: 配置.canaryModel, placeholder: 'gpt-6-sol', onChange: (e) => 改('canaryModel', e.target.value) }),
            ),
            h('label', null,
              h('div', { style: S.科目标签 }, '自动启动'),
              h('div', { style: { ...S.row, height: 26 } },
                h('input', { type: 'checkbox', checked: !!配置.autoStart, onChange: (e) => 改('autoStart', e.target.checked) }),
                h('span', { style: S.dim }, 'DSH 起来时自动拉起 bridge'),
              ),
            ),
          ),
          h('div', { style: { marginTop: 6 } },
            h('div', { style: S.科目标签 }, 'tokens.json（只显示路径，不读内容）'),
            h('input', { type: 'text', style: S.input, value: 配置.tokensFile, onChange: (e) => 改('tokensFile', e.target.value) }),
          ),
          h('div', { style: { marginTop: 6 } },
            h('div', { style: S.科目标签 }, 'bridge 入口（现有实现，不重写）'),
            h('input', { type: 'text', style: S.input, value: 配置.bridgeEntry, onChange: (e) => 改('bridgeEntry', e.target.value) }),
          ),
          h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { type: 'button', style: S.btnOn, disabled: 忙 || !草稿, onClick: 存 }, 草稿 ? '保存设置' : '没有改动'),
            h('button', { type: 'button', style: S.btn, disabled: 忙, onClick: 重启 }, '重启代理'),
            h('button', { type: 'button', style: S.btn, disabled: 忙, onClick: 拉 }, '重新读取'),
            说 ? h('span', { style: { ...S.dim, color: 说.includes('失败') || 说.includes('错误') ? '#c0392b' : 'inherit' } }, 说) : null,
          ),
          h('div', { style: { ...S.dim, marginTop: 6 } }, '改端口 / 代理 / tokens 路径会立刻按新配置重启插件自己托管的 bridge；如果端口上是外部进程，只会重新探测，不会去关它。'),
          h('div', { style: { ...S.dim, marginTop: 2 } },
            `主灯判据：页面可见时打开跑一次、之后每 ${自动测试间隔分钟} 分钟最多一次真实请求（模型 ${配置.canaryModel || 'gpt-6-sol'}，reasoning=none，实测约 22 tokens），结果缓存 60 秒——只有它能回答「现在能不能调用 GPT」；「立即测试」60 秒内也回到缓存，不会连点重复消耗。`,
          ),
          h('div', { style: { ...S.dim, marginTop: 2 } },
            `穿透探测：经上面的代理对 ${(态.connectivity && 态.connectivity.target) || 'https://chatgpt.com/'} 做一次 TLS 握手（超时 ${((态.connectivity && 态.connectivity.timeoutMs) || 3000) / 1000} 秒，结果缓存 ${(态.connectivity && 态.connectivity.cacheSeconds) || 6} 秒），现在只作为主灯下面的链路详情——能握手说明路通，但不保证真的能调用模型。`,
          ),
        ),

        // —— 路径与日志 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '路径'),
          h('div', { style: S.mono }, `配置：${态.paths.configFile}`),
          h('div', { style: S.mono }, `tokens：${态.paths.tokensFile}`),
          h('div', { style: S.mono }, `bridge：${态.paths.bridgeEntry}`),
          h('div', { style: S.mono }, `日志：${态.paths.logFile}`),
          h('div', { style: S.mono }, `node：${态.paths.node || '（由宿主决定）'}`),
          h('details', { style: { marginTop: 8 } },
            h('summary', { style: { cursor: 'pointer', fontSize: 12 } }, `插件日志（最近 ${(侧车.logs || []).length} 条）`),
            h('div', { style: { maxHeight: 220, overflowY: 'auto', marginTop: 6 } },
              (侧车.logs || []).length === 0
                ? h('div', { style: S.dim }, '还没有日志。')
                : (侧车.logs || []).slice(-30).map((行, i) => h('div', { key: i, style: S.最近行 }, 行)),
            ),
          ),
        ),

        h('div', { style: S.dim }, `额度来自 ChatGPT 后端 /backend-api/wham/usage（5 小时 + 7 天窗口）。页面可见时打开跑一次极小的真实调用（约 22 tokens）并缓存 60 秒，之后每 ${自动测试间隔分钟} 分钟最多一次，页面隐藏时暂停；除此之外本页只读，没有 token 内容、也不读 .credentials.yaml。`),
      )
    }

    function apply(ctx) {
      const slots = ctx.get ? ctx.get('slots') : ctx.slots
      if (!slots) throw new Error('gpt-auto-proxy: 拿不到 slots 服务，设置页没法注册')
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'gpt-auto-proxy', order: 54, label: () => '订阅服务 / 用量' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { 窗口名, 倒计时, 百分比, 状态表, 进度色, 短id, 解析代理, 代理地址, 探测端点, 诊断, 有宿主探测, 连通短句, B, Section, 探活条, 探活标题, 探活原因, 链路详情文, 毫秒文, 时长文, 探活已过期, 额度诊断文, 额度数据文 }
    return module.exports
  },
})
