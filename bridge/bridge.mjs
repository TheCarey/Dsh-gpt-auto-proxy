#!/usr/bin/env node
/**
 * Local OpenAI Responses bridge → ChatGPT Codex backend.
 *
 *   POST /v1/responses   clean a Responses request, forward it to
 *                        https://chatgpt.com/backend-api/codex/responses with the
 *                        ChatGPT OAuth token, stream SSE back unchanged
 *   GET  /v1/models      model list (for DSH model discovery)
 *   GET  /v1/usage       ChatGPT 账号额度（/backend-api/wham/usage，5h + 7d 两个窗口）
 *   GET  /health         200 + token state
 *
 * Why this exists: DSH's pi-ai adapter can talk `openai-responses` to any
 * baseURL, but the ChatGPT backend is not a plain OpenAI endpoint (OAuth token,
 * chatgpt-account-id header, store:false, instructions hoisted out of input).
 * This bridge makes the ChatGPT backend look like a normal OpenAI Responses API.
 *
 * Run:
 *   node bridge.mjs                 (needs the proxy: re-execs itself with
 *                                    NODE_USE_ENV_PROXY=1 when needed)
 *   start-bridge.cmd                (same, detached/minimized)
 *
 * Env:
 *   CODEX_BRIDGE_PORT       default 8787
 *   CODEX_BRIDGE_PROXY      default http://127.0.0.1:7890 ("none" disables)
 *   CODEX_BRIDGE_UPSTREAM   default https://chatgpt.com/backend-api/codex/responses
 *   CODEX_BRIDGE_TOKENS     default ./tokens.json
 *   CODEX_BRIDGE_LOG        default ./bridge.log
 *   CODEX_BRIDGE_AUTH_BASE  default https://auth.openai.com (tests)
 *   CODEX_BRIDGE_NO_PROXY=1 skip the proxy self re-exec
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const DEFAULT_PROXY = 'http://127.0.0.1:7890';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 120_000;
const UPSTREAM_HEADER_TIMEOUT_MS = 180_000;
const HEARTBEAT_MS = 10_000;

/** Model catalog lifted from pi-ai's openai-codex provider data. */
export const DEFAULT_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 128000, maxTokens: 128000, input: ['text'], reasoning: true },
];

/* ------------------------------------------------------------------ */
/* small utilities                                                    */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

class BridgeError extends Error {
  constructor(status, message, type = 'bridge_error', code = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function mask(value) {
  if (!value || typeof value !== 'string') return '(none)';
  if (value.length <= 12) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

function decodeJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function accountIdFromJwt(token) {
  const payload = decodeJwt(token);
  const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item) continue;
      if (typeof item === 'string') parts.push(item);
      else if (typeof item.text === 'string') parts.push(item.text);
    }
    return parts.join('\n');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function isSystemish(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.role !== 'system' && item.role !== 'developer') return false;
  return item.type === undefined || item.type === 'message';
}

/* ------------------------------------------------------------------ */
/* bridge                                                             */
/* ------------------------------------------------------------------ */

export function createBridge(overrides = {}) {
  const config = {
    host: overrides.host ?? '127.0.0.1',
    port: overrides.port ?? Number(process.env.CODEX_BRIDGE_PORT || 8787),
    upstream: overrides.upstream ?? process.env.CODEX_BRIDGE_UPSTREAM ?? 'https://chatgpt.com/backend-api/codex/responses',
    authBase: (overrides.authBase ?? process.env.CODEX_BRIDGE_AUTH_BASE ?? 'https://auth.openai.com').replace(/\/+$/, ''),
    tokensFile: overrides.tokensFile ?? process.env.CODEX_BRIDGE_TOKENS ?? path.join(ROOT, 'tokens.json'),
    logFile: overrides.logFile ?? process.env.CODEX_BRIDGE_LOG ?? path.join(ROOT, 'bridge.log'),
    usageUrl: overrides.usageUrl ?? process.env.CODEX_BRIDGE_USAGE_URL ?? 'https://chatgpt.com/backend-api/wham/usage',
    models: overrides.models ?? DEFAULT_MODELS,
    quiet: overrides.quiet ?? false,
  };

  const startedAt = Date.now();
  const tokenState = { tokens: null, mtimeMs: 0, refreshPromise: null };
  const stats = { requests: 0, ok: 0, errors: 0, refreshes: 0, tokensWritten: 0 };

  /* ---------------- logging ---------------- */

  function rotateLogIfNeeded() {
    try {
      const size = fs.statSync(config.logFile).size;
      if (size > MAX_LOG_BYTES) {
        fs.renameSync(config.logFile, `${config.logFile}.1`);
      }
    } catch {
      /* no file yet */
    }
  }

  function log(level, message, extra = {}) {
    const line = JSON.stringify({ t: nowIso(), level, msg: message, ...extra });
    if (!config.quiet) {
      try {
        console.log(line);
      } catch {
        /* detached process without console */
      }
    }
    try {
      fs.appendFileSync(config.logFile, line + '\n');
    } catch {
      /* logging must never break requests */
    }
  }

  /* ---------------- tokens ---------------- */

  function loadTokens({ force = false } = {}) {
    let stat;
    try {
      stat = fs.statSync(config.tokensFile);
    } catch {
      throw new BridgeError(
        401,
        `还没有登录：找不到 ${config.tokensFile}。请先在该目录运行 login.mjs 完成 ChatGPT 登录。`,
        'auth_error',
        'NOT_LOGGED_IN',
      );
    }
    if (!force && tokenState.tokens && stat.mtimeMs === tokenState.mtimeMs) return tokenState.tokens;
    const tokens = readJson(config.tokensFile);
    if (!tokens?.access_token || !tokens?.refresh_token) {
      throw new BridgeError(
        401,
        `${config.tokensFile} 不完整（缺少 access_token 或 refresh_token），请重新运行 login.mjs。`,
        'auth_error',
        'INVALID_TOKENS_FILE',
      );
    }
    tokenState.tokens = tokens;
    tokenState.mtimeMs = stat.mtimeMs;
    return tokens;
  }

  async function refreshTokens(tokens) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    });
    let response;
    try {
      response = await fetch(`${config.authBase}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new BridgeError(
        502,
        `刷新 ChatGPT token 时网络错误：${error?.message || error}（检查代理是否可用）`,
        'upstream_error',
        'REFRESH_NETWORK',
      );
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new BridgeError(
        401,
        `刷新 ChatGPT token 失败（HTTP ${response.status}）：${text.slice(0, 400) || '(空响应)'}。请重新运行 login.mjs。`,
        'auth_error',
        'REFRESH_FAILED',
      );
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BridgeError(502, '刷新 token 返回了非 JSON 响应，请重新登录。', 'upstream_error', 'REFRESH_BAD_BODY');
    }
    if (!json?.access_token || typeof json.expires_in !== 'number') {
      throw new BridgeError(502, '刷新 token 的响应缺少字段，请重新登录。', 'upstream_error', 'REFRESH_BAD_BODY');
    }
    const accountId =
      accountIdFromJwt(json.access_token) ||
      (json.id_token && accountIdFromJwt(json.id_token)) ||
      tokens.account_id ||
      null;
    const next = {
      ...tokens,
      access_token: json.access_token,
      refresh_token: json.refresh_token || tokens.refresh_token,
      id_token: json.id_token ?? tokens.id_token ?? null,
      token_type: json.token_type ?? tokens.token_type ?? 'Bearer',
      scope: json.scope ?? tokens.scope,
      expires_at: Date.now() + json.expires_in * 1000,
      refreshed_at: nowIso(),
      account_id: accountId,
    };
    writeJsonAtomic(config.tokensFile, next, 0o600);
    tokenState.tokens = next;
    try {
      tokenState.mtimeMs = fs.statSync(config.tokensFile).mtimeMs;
    } catch {
      tokenState.mtimeMs = 0;
    }
    stats.refreshes += 1;
    stats.tokensWritten += 1;
    log('info', 'token refreshed', { account: mask(accountId), expires: new Date(next.expires_at).toISOString() });
    return next;
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    let tokens = loadTokens({ force: forceRefresh });
    if (forceRefresh || Number(tokens.expires_at ?? 0) - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      if (!tokenState.refreshPromise) {
        tokenState.refreshPromise = (async () => {
          try {
            return await refreshTokens(loadTokens());
          } finally {
            tokenState.refreshPromise = null;
          }
        })();
      }
      tokens = await tokenState.refreshPromise;
      // A concurrent login.mjs run may have replaced the file with a newer token.
      const onDisk = loadTokens({ force: true });
      if (Number(onDisk.expires_at ?? 0) > Number(tokens.expires_at ?? 0)) tokens = onDisk;
    }
    if (!tokens.account_id) {
      tokens = { ...tokens, account_id: accountIdFromJwt(tokens.access_token) };
      if (!tokens.account_id) {
        throw new BridgeError(
          401,
          'token 里没有 chatgpt_account_id，请重新运行 login.mjs。',
          'auth_error',
          'NO_ACCOUNT_ID',
        );
      }
    }
    return tokens;
  }

  /* ---------------- request preparation ---------------- */

  function prepareUpstreamBody(raw, sessionId) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BridgeError(400, '请求体必须是 JSON 对象。', 'invalid_request_error', 'BAD_BODY');
    }
    if (typeof raw.model !== 'string' || raw.model.length === 0) {
      throw new BridgeError(400, '请求体缺少 model。', 'invalid_request_error', 'MISSING_MODEL');
    }
    const body = { ...raw };

    // Fields the Codex backend rejects or handles differently.
    for (const field of [
      'max_output_tokens',
      'max_completion_tokens',
      'max_tokens',
      'prompt_cache_retention',
      'prompt_cache_options',
      'metadata',
      'user',
      'truncation',
      'previous_response_id',
      'background',
      'conversation',
      'service_tier',
      'temperature',
      'top_p',
      'top_k',
      'stop',
      'stream_options',
    ]) {
      delete body[field];
    }

    // input → array, hoist the leading system/developer message into instructions.
    let input = body.input;
    if (typeof input === 'string') {
      input = [{ role: 'user', content: [{ type: 'input_text', text: input }] }];
    }
    if (!Array.isArray(input)) {
      throw new BridgeError(400, 'input 必须是数组或字符串。', 'invalid_request_error', 'BAD_INPUT');
    }
    const hoisted = [];
    while (input.length > 0 && isSystemish(input[0])) {
      const text = contentToText(input[0].content);
      if (text.trim().length > 0) hoisted.push(text);
      input.shift();
    }
    if (input.length === 0) {
      input = [{ role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }];
    }
    body.input = input;

    const instructions = [raw.instructions, ...hoisted]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
    body.instructions = instructions || 'You are a helpful assistant.';

    body.store = false;
    body.stream = true;
    const include = new Set(Array.isArray(raw.include) ? raw.include : []);
    include.add('reasoning.encrypted_content');
    body.include = [...include];

    const text = raw.text && typeof raw.text === 'object' && !Array.isArray(raw.text) ? { ...raw.text } : {};
    if (typeof text.verbosity !== 'string') text.verbosity = 'low';
    body.text = text;

    const cacheKey =
      typeof raw.prompt_cache_key === 'string' && raw.prompt_cache_key.length > 0
        ? raw.prompt_cache_key
        : sessionId;
    body.prompt_cache_key = String(cacheKey).slice(0, 64);

    if (body.tool_choice === undefined) body.tool_choice = 'auto';
    if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = true;

    return body;
  }

  function buildUpstreamHeaders(tokens, sessionId) {
    const headers = {
      authorization: `Bearer ${tokens.access_token}`,
      originator: 'pi',
      'user-agent': `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
      'openai-beta': 'responses=experimental',
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'accept-encoding': 'identity',
    };
    if (tokens.account_id) headers['chatgpt-account-id'] = tokens.account_id;
    if (sessionId) {
      headers['session-id'] = sessionId;
      headers['x-client-request-id'] = sessionId;
    }
    return headers;
  }

  /* ---------------- responses handler ---------------- */

  async function readRequestBody(req) {
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          done = true;
          reject(new BridgeError(413, `请求体超过 ${MAX_BODY_BYTES} 字节上限。`, 'invalid_request_error', 'BODY_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', (error) => {
        if (done) return;
        done = true;
        reject(error);
      });
    });
  }

  async function handleResponses(req, res) {
    const started = Date.now();
    stats.requests += 1;
    let model = '(unknown)';
    let wroteHead = false;
    try {
      const rawText = await readRequestBody(req);
      let raw;
      try {
        raw = rawText.length > 0 ? JSON.parse(rawText) : {};
      } catch {
        throw new BridgeError(400, '请求体不是合法 JSON。', 'invalid_request_error', 'BAD_JSON');
      }
      model = typeof raw.model === 'string' ? raw.model : '(missing)';
      const sessionId =
        req.headers['session_id'] ||
        req.headers['x-client-request-id'] ||
        req.headers['x-session-id'] ||
        raw.prompt_cache_key ||
        crypto.randomUUID();
      const body = prepareUpstreamBody(raw, String(sessionId));
      const wantsStream = raw.stream !== false;
      log('info', 'responses request', {
        model,
        session: mask(String(sessionId)),
        stream: wantsStream,
        input_items: body.input.length,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
      });

      let upstreamResponse;
      for (let attempt = 0; ; attempt += 1) {
        const tokens = await getAccessToken({ forceRefresh: attempt > 0 });
        const controller = new AbortController();
        const headerTimer = setTimeout(
          () => controller.abort(new Error('upstream header timeout')),
          UPSTREAM_HEADER_TIMEOUT_MS,
        );
        const onClientClose = () => {
          if (!res.writableEnded) controller.abort(new Error('client closed'));
        };
        res.on('close', onClientClose);
        try {
          upstreamResponse = await fetch(config.upstream, {
            method: 'POST',
            headers: buildUpstreamHeaders(tokens, String(sessionId)),
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          clearTimeout(headerTimer);
          res.off('close', onClientClose);
          if (res.destroyed) return;
          throw new BridgeError(
            502,
            `连接 ChatGPT 后端失败：${error?.message || error}。可用 CODEX_BRIDGE_UPSTREAM 覆盖上游，或检查代理。`,
            'upstream_error',
            'UPSTREAM_UNREACHABLE',
          );
        }
        clearTimeout(headerTimer);

        if (upstreamResponse.status === 401 && attempt === 0) {
          await upstreamResponse.text().catch(() => '');
          res.off('close', onClientClose);
          log('warn', 'upstream returned 401, refreshing token and retrying once', { model });
          continue;
        }
        if (!upstreamResponse.ok) {
          const text = await upstreamResponse.text().catch(() => '');
          res.off('close', onClientClose);
          const detail = extractUpstreamError(text, upstreamResponse.status);
          const status =
            upstreamResponse.status === 429 || upstreamResponse.status === 400 || upstreamResponse.status === 404
              ? upstreamResponse.status
              : upstreamResponse.status >= 500
                ? 502
                : upstreamResponse.status;
          throw new BridgeError(status, detail, 'upstream_error', `UPSTREAM_${upstreamResponse.status}`);
        }

        if (wantsStream) {
          await pipeStream(upstreamResponse, res, { onClientClose });
          wroteHead = true;
        } else {
          await respondAggregated(upstreamResponse, res);
          wroteHead = true;
        }
        res.off('close', onClientClose);
        break;
      }
      stats.ok += 1;
      log('info', 'responses done', { model, status: 200, ms: Date.now() - started });
    } catch (error) {
      stats.errors += 1;
      const bridgeError =
        error instanceof BridgeError
          ? error
          : new BridgeError(500, `桥内部错误：${error?.message || error}`, 'bridge_error', 'INTERNAL');
      log('error', 'responses failed', {
        model,
        status: bridgeError.status,
        code: bridgeError.code,
        message: bridgeError.message.slice(0, 600),
        ms: Date.now() - started,
      });
      if (res.headersSent || wroteHead) {
        if (!res.writableEnded) {
          try {
            res.write(
              `data: ${JSON.stringify({ type: 'error', error: { message: bridgeError.message, type: bridgeError.type, code: bridgeError.code } })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
          } catch {
            /* client gone */
          }
          res.end();
        }
        return;
      }
      sendJson(res, bridgeError.status, {
        error: { message: bridgeError.message, type: bridgeError.type, code: bridgeError.code },
      });
    }
  }

  function extractUpstreamError(text, status) {
    const fallback = text?.slice(0, 600) || `ChatGPT 后端返回 HTTP ${status}`;
    try {
      const parsed = JSON.parse(text);
      const err = parsed?.error;
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object') {
        const code = err.code || err.type;
        const message = err.message || fallback;
        return status === 429
          ? `${message}${code ? ` [${code}]` : ''}（ChatGPT 额度/频率限制）`
          : `${message}${code ? ` [${code}]` : ''}`;
      }
      if (typeof parsed?.detail === 'string') return parsed.detail;
    } catch {
      /* not JSON */
    }
    return fallback;
  }

  async function pipeStream(upstreamResponse, res, { onClientClose }) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    let sawDone = false;
    let tail = '';
    let bytes = 0;
    let lastWrite = Date.now();
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      if (Date.now() - lastWrite >= HEARTBEAT_MS) {
        try {
          res.write(': ping\n\n');
          lastWrite = Date.now();
        } catch {
          /* client gone */
        }
      }
    }, HEARTBEAT_MS);

    try {
      for await (const chunk of upstreamResponse.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        const text = buffer.toString('utf8');
        tail = (tail + text).slice(-64);
        if (tail.includes('[DONE]')) sawDone = true;
        if (!res.write(buffer)) {
          // Backpressure: wait for drain, but never hang forever.
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.on('drain', done);
            res.on('close', done);
          });
        }
        lastWrite = Date.now();
      }
      if (!sawDone && !res.writableEnded) res.write('data: [DONE]\n\n');
      res.end();
      log('info', 'stream finished', { bytes });
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(
            `data: ${JSON.stringify({ type: 'error', error: { message: `上游流中断：${error?.message || error}`, type: 'upstream_error' } })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
        } catch {
          /* client gone */
        }
        res.end();
      }
      log('warn', 'stream interrupted', { bytes, message: String(error?.message || error) });
    } finally {
      clearInterval(heartbeat);
      res.off('close', onClientClose);
    }
  }

  async function respondAggregated(upstreamResponse, res) {
    const text = await upstreamResponse.text();
    const events = parseSseEvents(text);
    let response = null;
    for (const event of events) {
      const payload = event.data;
      if (payload?.type === 'response.completed' || payload?.type === 'response.done') {
        response = payload.response ?? payload;
      }
      if (payload?.error) {
        sendJson(res, 502, { error: { message: payload.error.message || '上游出错', type: 'upstream_error' } });
        return;
      }
    }
    if (!response) {
      sendJson(res, 502, { error: { message: '上游没有返回完整响应', type: 'upstream_error' } });
      return;
    }
    sendJson(res, 200, response);
  }

  function parseSseEvents(text) {
    const events = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      let eventName = null;
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const dataText = dataLines.join('\n');
      if (dataText === '[DONE]') {
        events.push({ event: eventName, data: '[DONE]' });
        continue;
      }
      try {
        events.push({ event: eventName, data: JSON.parse(dataText) });
      } catch {
        events.push({ event: eventName, data: dataText });
      }
    }
    return events;
  }

  /* ---------------- usage ---------------- */

  /**
   * ChatGPT 套餐额度。
   *
   * 上游：GET https://chatgpt.com/backend-api/wham/usage
   *   headers: authorization: Bearer <access_token>
   *            chatgpt-account-id: <token 里的 chatgpt_account_id>
   *            originator: codex_cli_rs
   * 返回（2026-10 实测）：
   *   { email, plan_type: "plus", rate_limit: { allowed, limit_reached,
   *     primary_window:   { used_percent, limit_window_seconds, reset_after_seconds, reset_at },
   *     secondary_window: { ... } }, credits: {...}, rate_limit_reset_credits: {...} }
   * 这里把它洗成插件设置页直接能用的形状；原始 tokens 一律不出现在响应里。
   */

  function percentLeft(used) {
    const n = Number(used);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, 100 - n));
  }

  function normalizeWindow(window, label) {
    if (!window || typeof window !== 'object') return null;
    const used = Number(window.used_percent);
    const secs = Number(window.limit_window_seconds);
    const resetAfter = Number(window.reset_after_seconds);
    const resetAt = Number(window.reset_at);
    return {
      label,
      windowSeconds: Number.isFinite(secs) ? secs : null,
      usedPercent: Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
      remainingPercent: Number.isFinite(used) ? percentLeft(used) : null,
      resetAfterSeconds: Number.isFinite(resetAfter) ? resetAfter : null,
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
    };
  }

  function normalizeUsage(raw, fetchedAt) {
    const rate = raw?.rate_limit && typeof raw.rate_limit === 'object' ? raw.rate_limit : {};
    const credits = raw?.credits && typeof raw.credits === 'object' ? raw.credits : {};
    const reset = raw?.rate_limit_reset_credits && typeof raw.rate_limit_reset_credits === 'object' ? raw.rate_limit_reset_credits : {};
    const spend = raw?.spend_control && typeof raw.spend_control === 'object' ? raw.spend_control : {};
    return {
      ok: true,
      fetchedAt: new Date(fetchedAt).toISOString(),
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
        primary: normalizeWindow(rate.primary_window, 'primary'),
        secondary: normalizeWindow(rate.secondary_window, 'secondary'),
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
    };
  }

  async function fetchUsage({ forceRefresh = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tokens = await getAccessToken({ forceRefresh: forceRefresh || attempt > 0 });
      const headers = {
        authorization: `Bearer ${tokens.access_token}`,
        originator: 'codex_cli_rs',
        'user-agent': `codex_cli_rs (${os.platform()} ${os.release()}; ${os.arch()})`,
        accept: 'application/json',
        'accept-encoding': 'identity',
      };
      if (tokens.account_id) headers['chatgpt-account-id'] = tokens.account_id;
      let response;
      try {
        response = await fetch(config.usageUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new BridgeError(
          502,
          `读取 ChatGPT 用量失败：${error?.message || error}（检查本机代理是否可用）`,
          'upstream_error',
          'USAGE_NETWORK',
        );
      }
      const text = await response.text().catch(() => '');
      if (response.status === 401 && attempt === 0) {
        lastError = new BridgeError(401, '读取用量时上游返回 401，已刷新 token 并重试。', 'auth_error', 'USAGE_401');
        continue;
      }
      if (!response.ok) {
        throw new BridgeError(
          response.status === 429 ? 429 : 502,
          `读取 ChatGPT 用量失败（HTTP ${response.status}）：${text.slice(0, 300) || '(空响应)'}`,
          'upstream_error',
          `USAGE_${response.status}`,
        );
      }
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new BridgeError(502, '用量接口返回了非 JSON 响应。', 'upstream_error', 'USAGE_BAD_BODY');
      }
      return normalizeUsage(raw, Date.now());
    }
    throw lastError ?? new BridgeError(401, '读取用量时上游一直返回 401，请重新登录。', 'auth_error', 'USAGE_401');
  }

  async function handleUsage(res) {
    try {
      const usage = await fetchUsage();
      log('info', 'usage fetched', {
        plan: usage.account.planType,
        primary: usage.rateLimit.primary?.usedPercent,
        secondary: usage.rateLimit.secondary?.usedPercent,
      });
      sendJson(res, 200, usage);
    } catch (error) {
      const bridgeError =
        error instanceof BridgeError
          ? error
          : new BridgeError(500, `用量内部错误：${error?.message || error}`, 'bridge_error', 'USAGE_INTERNAL');
      log('warn', 'usage failed', {
        status: bridgeError.status,
        code: bridgeError.code,
        message: bridgeError.message.slice(0, 400),
      });
      sendJson(res, bridgeError.status, { ok: false, error: { message: bridgeError.message, type: bridgeError.type, code: bridgeError.code } });
    }
  }

  /* ---------------- other routes ---------------- */

  function sendJson(res, status, payload) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function handleModels(res) {
    sendJson(res, 200, {
      object: 'list',
      data: config.models.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'openai',
        name: model.name,
        context_window: model.contextWindow,
        max_output_tokens: model.maxTokens,
        capabilities: {
          reasoning: Boolean(model.reasoning),
          input_modalities: model.input,
        },
      })),
    });
  }

  function handleHealth(res) {
    let tokens = null;
    let tokenError = null;
    try {
      tokens = loadTokens({ force: true });
    } catch (error) {
      tokenError = error?.message || String(error);
    }
    sendJson(res, 200, {
      status: 'ok',
      service: 'codex-bridge',
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      upstream: config.upstream,
      tokensFile: config.tokensFile,
      logFile: config.logFile,
      usageUrl: config.usageUrl,
      features: ['usage'],
      endpoints: ['GET /health', 'GET /v1/models', 'GET /v1/usage', 'POST /v1/responses'],
      hasTokens: Boolean(tokens),
      accountId: tokens?.account_id ?? null,
      tokenExpiresAt: tokens?.expires_at ? new Date(Number(tokens.expires_at)).toISOString() : null,
      tokenExpired: tokens ? Number(tokens.expires_at) <= Date.now() : null,
      tokenError,
      models: config.models.length,
      stats,
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/health') return handleHealth(res);
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) return handleModels(res);
    if (req.method === 'GET' && (pathname === '/v1/usage' || pathname === '/usage')) {
      return handleUsage(res).catch((error) => {
        log('error', 'unhandled usage failure', { message: String(error?.message || error) });
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { message: 'bridge usage internal error', type: 'bridge_error' } });
      });
    }
    if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) {
      return handleResponses(req, res).catch((error) => {
        log('error', 'unhandled responses failure', { message: String(error?.message || error) });
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: 'bridge internal error', type: 'bridge_error' } });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    }
    if (req.method === 'GET' && pathname === '/') {
      return sendJson(res, 200, {
        service: 'codex-bridge',
        endpoints: ['GET /health', 'GET /v1/models', 'GET /v1/usage', 'POST /v1/responses'],
        upstream: config.upstream,
      });
    }
    sendJson(res, 404, { error: { message: `没有这个路由：${req.method} ${pathname}`, type: 'not_found' } });
  });

  server.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  rotateLogIfNeeded();
  log('info', 'bridge created', {
    upstream: config.upstream,
    tokensFile: config.tokensFile,
    models: config.models.length,
  });

  return {
    server,
    config,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : config.port;
          log('info', 'bridge listening', { host: config.host, port, pid: process.pid });
          resolve({ host: config.host, port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------ */
/* entry                                                              */
/* ------------------------------------------------------------------ */

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const PROXY = process.env.CODEX_BRIDGE_PROXY ||
    process.env.HTTPS_PROXY || process.env.https_proxy || DEFAULT_PROXY;
  const proxyDisabled =
    PROXY === 'none' || PROXY === '' || process.env.CODEX_BRIDGE_NO_PROXY === '1';
  const proxied =
    process.env.NODE_USE_ENV_PROXY === '1' || process.env.CODEX_BRIDGE_BOOTSTRAPPED === '1';

  if (!proxied && !proxyDisabled) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: PROXY,
        HTTP_PROXY: PROXY,
        https_proxy: PROXY,
        http_proxy: PROXY,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        CODEX_BRIDGE_BOOTSTRAPPED: '1',
        CODEX_BRIDGE_PROXY: PROXY,
      },
    });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    child.on('error', (error) => {
      console.error(`bridge: failed to re-exec with proxy env: ${error?.message || error}`);
      process.exit(1);
    });
  } else {
    const bridge = createBridge();
    const { port, host } = await bridge.listen();
    console.log(`\ncodex-bridge listening on http://${host}:${port}/v1\n`);
    const shutdown = async (signal) => {
      try {
        await bridge.close();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
