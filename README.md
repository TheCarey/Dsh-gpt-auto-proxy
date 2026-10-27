# dsh-gpt-auto-proxy

> ## ⚠️ 免责声明（请务必先读）
>
> - 本项目是**非官方**的个人项目，与 **OpenAI、ChatGPT、Codex 以及任何上游服务提供方均无任何隶属、合作、授权或背书关系**。相关名称与商标归各自所有者。
> - **仅供个人学习与技术研究**（协议转换、SSE 透传、本地进程托管、配置界面等工程实现）。
> - 本项目做的事是：把你**自己的订阅凭证**在本机转换成一个 **OpenAI 兼容的本地接口**，供你自己机器上的工具调用。这**不是**官方支持的能力。
> - **使用本项目的一切后果由使用者自行承担**，包括但不限于账号被限流、降级、**暂停或封禁**，以及由此产生的订阅费用与**法律责任**。
> - **禁止**商业转售、二次分发接口、对外提供付费/免费服务、批量滥用、账号池、凭证共享，以及任何形式的**规避付费与计费**。
> - 是否遵守上游服务条款（ToS / AUP）**完全由使用者自己负责**。不确定自己的用法是否合规，就请不要使用。

---

## 一句话简介

把**自己的** ChatGPT 订阅凭证，在本机转成一个 OpenAI 兼容的本地接口，并交给 DSH 插件托管：自动启停、额度只读展示、以及一次极小真实调用判断「现在到底能不能用」。

### 适合谁用

- 有**合法有效订阅**、只想在**自己这台机器**上自用的个人开发者；
- 已经习惯本地代理（如 Clash 类工具）与 Node.js，能自己看懂配置文件的人；
- 想顺手在 DSH 设置页里看一眼 5 小时 / 7 天额度窗口的人。

### 不适合谁用

- 想把它做成对外 API、卖给别人、或给一群人共用的人（本项目**不提供**这些能力，也**不允许**这样用）；
- 没有自己的订阅、想找一条绕过付费的路子的人；
- 期待「一键装完永久免维护」的人（上游接口是私有的，随时可能变化）。

---

## 它做什么 / 它不做什么

### 它做什么

- 在 `127.0.0.1:<LOCAL_PORT>` 起一个**只监听本机回环地址**的 HTTP 服务，把 OpenAI Responses 风格的请求清洗后转发到上游，SSE 原样流回；
- 凭证失效（401）时用 `refresh_token` 自动刷新，并按文件修改时间重载凭证；
- 提供一个**只读**的额度查询接口，供设置页显示 5 小时 / 7 天用量；
- 作为 DSH 插件：DSH 启动时拉起本地服务，DSH 退出时一并回收；端口已被占用时**只复用、不抢占**；
- 可选地发一次**极小的真实调用**判断链路是否真的通（会消耗极少量额度）。

### 它不做什么（明确划界）

- ❌ **不做账号池**：凭证模型是单文件、单账号，没有多账号轮换、没有池化调度；
- ❌ **不做批量注册**：不包含任何注册、验证码、批量开号相关的逻辑；
- ❌ **不提供凭证共享**：不导出凭证、不中转他人凭证、没有「分享给别人用」的通道；
- ❌ **不代理他人流量**：默认只监听回环地址，设计上不面向局域网/公网提供服务，**严禁**改成对外监听；
- ❌ **不绕过付费**：不修改计费、不伪造用量、不规避额度限制；
- ❌ **不提供凭证获取流程**：不包含登录/注册脚本，凭证必须你自己通过官方途径获得。

---

## 工作原理

```
你的客户端（curl / SDK / 编辑器插件 / DSH 模型连接）
        │   ① 发 OpenAI Responses 风格请求，Authorization: Bearer <任意占位串>
        ▼
本机 dsh-gpt-auto-proxy  ——  只监听 127.0.0.1:<LOCAL_PORT>
        │   ② 清洗请求：整理字段、把系统指令提到顶层、剔除上游不认的字段
        │   ③ 读 <YOUR_TOKEN_FILE> 里的 access_token（只读，页面不显示内容）
        ▼
可选的本机 HTTP 代理（默认 http://127.0.0.1:<PROXY_PORT>，可关闭）
        ▼
上游服务（订阅所属的对话服务后端）
        │   ④ 鉴权、限流、生成
        ▼
        ▲   ⑤ SSE 分片原样流回客户端
```

要点：

- 凭证**始终留在本机**，不经过任何第三方服务器；
- 服务的入站请求只接受本机回环地址；
- 日志里的凭证一律打码（只留首尾若干位），不落明文。

---

## 安装与配置

### 环境要求

- Node.js **≥ 22**（用到内置 `fetch`、`AbortSignal.timeout`）；
- DSH（可选：`bridge/bridge.mjs` 也能脱离 DSH 单独运行）；
- 你自己的订阅账号与对应的凭证文件；
- 能访问上游的网络环境；如需代理，自备本机 HTTP 代理。

### 一、准备凭证文件

本项目**不提供**登录流程。请按官方客户端的方式自行完成一次登录，得到一个形如下面的文件：

```json
{
  "access_token": "<ACCESS_TOKEN>",
  "refresh_token": "<REFRESH_TOKEN>",
  "account_id": "<ACCOUNT_ID>",
  "expires_at": 0
}
```

- 路径建议：`<YOUR_TOKEN_FILE>`（例如放在你的用户目录下，**不要**放进任何代码仓库）；
- 文件权限建议设为「仅本人可读」，因为它可以直接调用你的账号；
- **绝对不要**公开、截图、贴进 issue 或聊天记录。

### 二、装进 DSH（插件形态）

1. 把本目录放到你的 DSH profile 下：

   ```
   <DSH_HOME>/profiles/<PROFILE>/node_modules/dsh-gpt-auto-proxy
   ```

2. 在 profile 的 `package.json` 里登记两处：

   ```json
   "dependencies": {
     "dsh-gpt-auto-proxy": "file:node_modules/dsh-gpt-auto-proxy"
   },
   "dsh": {
     "profile": {
       "bundles": ["dsh-gpt-auto-proxy"]
     }
   }
   ```

   `dsh.profile.bundles` 才是真正的启用入口；组合包自带的 `cordis.patch.yml` 会在组合时被应用，因此**不要**再往 profile 的 `cordis.patch.yml` 里手写 `insert`（会重复注册）。

3. 重启 DSH，设置页出现 **「订阅服务 / 用量」** 即为成功。

### 三、配置文件

复制 `config.example.json` 为 `<DSH_HOME>/gpt-auto-proxy.json`，按需修改（缺省字段自动使用默认值）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `autoStart` | `true` | DSH 启动时是否自动拉起本地服务 |
| `port` | `<LOCAL_PORT>`（默认 8787） | 本地监听端口；被占用则复用，不抢 |
| `proxy` | `http://127.0.0.1:<PROXY_PORT>` | 出网代理；空字符串 = 不走代理 |
| `tokensFile` | `<DSH_HOME>/gpt-auto-proxy/tokens.json` | 凭证文件路径（**只读**，界面只显示路径） |
| `bridgeEntry` | 插件自带实现 | 想接外部实现时指过去 |
| `usageUrl` | 上游额度接口 | 额度查询地址 |
| `usageCacheSeconds` | `60` | 额度缓存秒数 |
| `canaryModel` | `gpt-6-sol` | 真实调用探活用的模型；账号不支持时换一个可用的 |
| `canaryTimeoutMs` | `20000` | 探活超时 |
| `probeUrl` / `probeCacheSeconds` | 上游首页 / `6` | 连通性探测，仅作辅助信息 |

外部路径也可用环境变量覆盖：`GPT_PROXY_BRIDGE_ENTRY`、`GPT_PROXY_TOKENS_FILE`（留空即不启用）。

### 四、独立运行（不装 DSH）

```bash
CODEX_BRIDGE_PORT=<LOCAL_PORT> \
CODEX_BRIDGE_PROXY=http://127.0.0.1:<PROXY_PORT> \
CODEX_BRIDGE_TOKENS=<YOUR_TOKEN_FILE> \
node bridge/bridge.mjs
```

可用端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/responses` | 转发到上游，SSE 流回 |
| GET | `/v1/models` | 可用模型列表 |
| GET | `/v1/usage` | 账号额度（5 小时 / 7 天窗口） |
| GET | `/health` | 健康检查与凭证状态（不含凭证原文） |

---

## 使用示例

> 以下 `sk-local-dummy` 是**假 token**，仅用于占位——本地服务不校验它，真正的凭证由服务自己去读 `<YOUR_TOKEN_FILE>`。

### curl

```bash
curl http://127.0.0.1:<LOCAL_PORT>/v1/responses \
  -H "Authorization: Bearer sk-local-dummy" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-sol",
    "input": "用一句话解释什么是 SSE。",
    "stream": false
  }'
```

流式：

```bash
curl -N http://127.0.0.1:<LOCAL_PORT>/v1/responses \
  -H "Authorization: Bearer sk-local-dummy" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-sol","input":"写一个三行的 Python 循环","stream":true}'
```

### OpenAI 兼容客户端（任意语言）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:<LOCAL_PORT>/v1",
    api_key="sk-local-dummy",          # 占位串，随便填
)

resp = client.responses.create(model="gpt-6-sol", input="你好")
print(resp.output_text)
```

```js
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:<LOCAL_PORT>/v1',
  apiKey: 'sk-local-dummy',            // 占位串
})

const res = await client.responses.create({ model: 'gpt-6-sol', input: '你好' })
console.log(res.output_text)
```

### 在 DSH 里用

1. 确保插件已启用、本地服务在跑；
2. 在模型设置里添加一个自定义连接，地址填 `http://127.0.0.1:<LOCAL_PORT>/v1`；
3. 打开设置页「订阅服务 / 用量」看额度与主灯状态。

---

## 常见问题（FAQ）

### 为什么需要我自己准备凭证？

因为本项目**不包含**登录、注册或凭证获取流程——这是有意的设计。凭证代表你账号的授权，任何"自动帮你搞到凭证"的东西都意味着凭证经过第三方。本项目只做「拿到凭证之后的协议转换」，凭证从哪来、归谁所有，由你自己负责。

### 有没有被限流或封号的风险？

**有，而且不小。** 上游对这类非官方接入通常有明确条款限制，检测到异常调用模式（高频、异常 UA、多来源共用、超量并发）可能直接限流或封号。本项目无法、也不会替你规避这些检测。**请自行评估风险，不要用重要账号尝试。**

### 为什么不能公开分享 token？

`tokens.json`（或你的 `<YOUR_TOKEN_FILE>`）里的 `access_token` / `refresh_token` 等同于你账号的**登录态**。一旦泄露：别人可以用你的账号、消耗你的额度、看你的历史对话，且**你无法分辨是谁在用**。刷新令牌还可能让你自己的会话被踢下线。所以：不进仓库、不进截图、不进聊天记录、不放进同步盘。

### 支持哪些请求字段？

实现了 OpenAI Responses 风格的**子集**：

- **支持**：`model`、`input`（字符串或消息数组）、`instructions`、`stream`、`reasoning.effort`、`tools` / 工具调用回传、图片输入（取决于账号与模型能力）；
- **会被丢弃**：`max_output_tokens` 等上游不接受的字段（不报错，直接剔除）；
- **不保证支持**：`temperature` 等采样参数、后台任务、文件上传等更冷门的字段——上游是否接受以实际返回为准。

模型清单是**内置的静态列表**，上游随时可能增删模型；遇到 400/404 说明该模型当前不可用，换一个即可。

### 端口被占用了怎么办？

设计上「不抢端口」：如果 `<LOCAL_PORT>` 上已经有一个同类服务，插件只复用它；如果被其它程序占用，会进入冲突状态并保持不动，不会去杀别人进程。改 `port` 即可。

### 界面上的「现在能不能用」是怎么判断的？

不是看端口通不通，而是**真的发一次极小调用**（约 20 多个 token），按返回结果分类成「可用 / 凭证失效 / 额度用尽 / 网络不通 / 本地服务未运行 / 上游故障 / 请求被拒」。结果缓存 60 秒，页面可见时最多每 5 分钟一次。**这会消耗极少量额度**，介意就别点。

---

## 许可证与致谢

本项目自有代码以 **MIT** 许可证发布，见 [LICENSE](LICENSE)。

第三方来源（详见 [NOTICE](NOTICE)）：

- `bridge/bridge.mjs` 里的模型目录字段取自 **pi-ai**（`@mariozechner/pi-ai`，作者 Mario Zechner）的 openai-codex provider 数据；仅复制事实性字段，未复制其实现。**使用/再分发前请自行核对其许可证。**
- 请求头中的 OAuth 客户端标识与 `originator` / User-Agent 约定，来自 OpenAI 官方开源的 Codex CLI（Apache-2.0）及公开 API 行为；这些是公开常量，不构成任何授权。
- 本项目是 **DSH** 的第三方插件，依赖其 `webServer` 与客户端注入槽；本仓库不含 DSH 代码。

本仓库**不包含**上游服务提供方的任何源代码。

再次提醒：**合规使用、封号风险、以及上游服务条款的责任，都在使用者本人。**