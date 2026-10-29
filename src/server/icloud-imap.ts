// 面板直连 iCloud IMAP 取完整正文（绕过引擎被洗空的 preview）。
//
// 为什么需要：icloud-hme 引擎的 readBody 只认顶层 Content-Type，遇到
// multipart/alternative 会把整段 boundary 原文当 text/plain 再洗成空串，
// 表现为 preview/bodyText/bodyHtml 全空，藏在 HTML 里的验证链接拿不到。
// 引擎 /api/inbox/:id 的 body 走同一逻辑，原始 MIME 从不离开引擎。
//
// 设计约束（按只读审查意见收紧）：
// 1) 账户绑定：凭据必须与 provider.accountId 指向的账户身份一致，不一致直接拒绝，
//    否则两个账号同 UID 时会把 A 的正文配到 B 的标题上（静默张冠李戴）。
// 2) 单账号串行：同账号同时只允许一条 IMAP 连接，其余排队；避免并发打爆 Apple。
// 3) 显式预算：连接/认证、整体请求、单封原文大小都有上限；超限给明确状态。
// 4) 正文缓存：按「账户身份 + UID」缓存事实（含"确实没有 HTML"），不做负缓存。
// 5) 失败可区分：返回 status 而不是一律静默 null。
// 说明：UIDVALIDITY 是 UID 复用的真正判据，但引擎摘要不提供，这里无法校验；
// 账户身份绑定是当前条件下能做到的最强一致性保证。

import net from "node:net";
import { ImapFlow } from "imapflow";
import { SocksClient } from "socks";
import { simpleParser } from "mailparser";

export type IcloudBody = { text: string | null; html: string | null };

export type IcloudBodyStatus =
  | "ok"
  | "not_configured"
  | "account_mismatch"
  | "auth_failed"
  | "unavailable"
  | "too_large";

export type IcloudFetchResult = {
  /** 成功取到正文的邮件（可能部分成功）。 */
  bodies: Map<number, IcloudBody>;
  status: IcloudBodyStatus;
  /** 未取到正文的 UID → 原因（供上层区分，不静默）。 */
  failed: Map<number, Exclude<IcloudBodyStatus, "ok">>;
  reason?: string;
};

const CONNECT_TIMEOUT_MS = Number(process.env.ICLOUD_IMAP_CONNECT_TIMEOUT_MS || 8000);
const OVERALL_TIMEOUT_MS = Number(process.env.ICLOUD_IMAP_TIMEOUT_MS || 15000);
const MAX_SOURCE_BYTES = Number(process.env.ICLOUD_IMAP_MAX_BYTES || 8 * 1024 * 1024);
const CACHE_TTL_MS = Number(process.env.ICLOUD_IMAP_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX_ENTRIES = 300;

type Creds = { user: string; pass: string };

function creds(): Creds | null {
  const user = (process.env.ICLOUD_IMAP_EMAIL || process.env.ICLOUD_EMAIL || "").trim();
  const pass = (process.env.ICLOUD_IMAP_APP_PASSWORD || process.env.ICLOUD_APP_PASSWORD || "").trim();
  if (!user || !pass) return null;
  return { user, pass };
}

/** 是否配了直连凭据（UI/健康检查用）。 */
export function icloudImapConfigured(): boolean {
  return creds() !== null;
}

/** 面板直连所用的邮箱身份（用于和引擎账户比对）。 */
export function icloudImapIdentity(): string | null {
  return creds()?.user ?? null;
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------- 正文缓存：只缓存「已解析的事实」，不做负缓存 ----------
const cache = new Map<string, { body: IcloudBody; at: number }>();

function cacheKey(user: string, uid: number): string {
  return `${user.toLowerCase()}|${uid}`;
}

function cacheGet(user: string, uid: number): IcloudBody | null {
  const hit = cache.get(cacheKey(user, uid));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(user, uid));
    return null;
  }
  return hit.body;
}

function cacheSet(user: string, uid: number, body: IcloudBody): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey(user, uid), { body, at: Date.now() });
}

/** 清缓存（改凭据/换账号时用）。 */
export function clearIcloudBodyCache(): void {
  cache.clear();
}

// ---------- 单账号串行队列 ----------
const queues = new Map<string, Promise<unknown>>();

function withAccountLock<T>(user: string, task: () => Promise<T>): Promise<T> {
  const key = user.toLowerCase();
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  // 队列尾部不携带结果也不抛错，避免污染后续任务
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ---------- SOCKS5 中继（HF Space 出站 993 被拦时用）----------
// 只做 TCP 转发，不在本地终结 TLS：imapflow 仍与 imap.mail.me.com 直接握手，
// 通过 tls.servername 指定 SNI 保住证书校验，链路是端到端的。
let relayPort: number | null = null;

function proxyUrl(): string {
  return (process.env.ICLOUD_IMAP_SOCKS || process.env.SOCKS_PROXY || "").trim();
}

let lastError: string | null = null;

// SOCKS 代理串格式不统一（可能是 socks5://u:p@h:p、h:p:u:p、不带 scheme 等），
// 手写容错解析，别让 new URL 一失败就整条链路放弃。
type ProxyParts = { host: string; port: number; user?: string; pass?: string };
function parseProxy(raw: string): ProxyParts | null {
  const text = raw.trim();
  if (!text) return null;
  const body = text.replace(/^[a-z0-9+]+:\/\//i, "");
  const at = body.lastIndexOf("@");
  let creds = "";
  let hostPort = body;
  if (at >= 0) {
    creds = body.slice(0, at);
    hostPort = body.slice(at + 1);
  }
  const hp = hostPort.split(":", 2);
  const host = (hp[0] || "").trim();
  const port = Number(hp[1] || 1080);
  if (!host || !Number.isFinite(port)) return null;
  let user: string | undefined;
  let pass: string | undefined;
  if (creds) {
    const ci = creds.indexOf(":");
    user = ci >= 0 ? decodeURIComponent(creds.slice(0, ci)) : decodeURIComponent(creds);
    pass = ci >= 0 ? decodeURIComponent(creds.slice(ci + 1)) : undefined;
  }
  return { host, port, user, pass };
}

async function ensureRelay(): Promise<number | null> {
  const raw = proxyUrl();
  if (!raw) return null;
  if (relayPort) return relayPort;
  const proxy = parseProxy(raw);
  if (!proxy) { lastError = `代理串无法解析（长度 ${raw.length}）`; return null; }
  const targetHost = process.env.ICLOUD_IMAP_HOST || "imap.mail.me.com";
  const targetPort = Number(process.env.ICLOUD_IMAP_PORT || 993);

  const server = net.createServer((client) => {
    SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        userId: proxy.user,
        password: proxy.pass
      },
      command: "connect",
      destination: { host: targetHost, port: targetPort }
    })
      .then(({ socket }) => {
        client.pipe(socket).pipe(client);
        socket.on("error", () => client.destroy());
        client.on("error", () => socket.destroy());
      })
      .catch(() => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  relayPort = typeof addr === "object" && addr ? addr.port : null;
  return relayPort;
}

function newClient(c: Creds, viaRelayPort: number | null): ImapFlow {
  const host = process.env.ICLOUD_IMAP_HOST || "imap.mail.me.com";
  const base = {
    secure: true as const,
    auth: { user: c.user, pass: c.pass },
    logger: false as const,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: OVERALL_TIMEOUT_MS
  };
  if (viaRelayPort) {
    // 经本地 SOCKS 中继：连 127.0.0.1，但 SNI 仍与真实主机名握手，证书校验照旧
    return new ImapFlow({
      ...base,
      host: "127.0.0.1",
      port: viaRelayPort,
      tls: { servername: host }
    } as never);
  }
  return new ImapFlow({
    ...base,
    host,
    port: Number(process.env.ICLOUD_IMAP_PORT || 993)
  });
}

function pick(parsed: { text?: string | null; html?: unknown }): IcloudBody {
  const text = typeof parsed.text === "string" && parsed.text.trim() ? parsed.text : null;
  const html = typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : null;
  return { text, html };
}

export type FetchOptions = {
  /**
   * 引擎里该 provider.accountId 对应的邮箱地址。
   * 传了就做账户绑定校验：与面板直连凭据不一致则拒绝（返回 account_mismatch）。
   */
  expectedEmail?: string | null;
};

/**
 * 按 UID 批量取正文：同账号串行 + 一次连接 + 一次 UID 集合 fetch。
 * 永不抛错；失败通过 status / failed 表达，上层自己决定降级方式。
 */
export async function fetchIcloudBodies(uids: number[], options: FetchOptions = {}): Promise<IcloudFetchResult> {
  const failed = new Map<number, Exclude<IcloudBodyStatus, "ok">>();
  const ids = Array.from(new Set(uids.filter((n) => Number.isFinite(n) && n > 0)));
  const empty = (status: IcloudBodyStatus, reason?: string): IcloudFetchResult => ({
    bodies: new Map(),
    status,
    failed,
    reason
  });

  const c = creds();
  if (!c) return empty("not_configured", "未配置 ICLOUD_EMAIL / ICLOUD_APP_PASSWORD");
  if (ids.length === 0) return { bodies: new Map(), status: "ok", failed };

  // 账户绑定：身份不一致时拒绝，避免跨账号串正文
  const expected = (options.expectedEmail ?? "").trim();
  if (expected && !sameEmail(expected, c.user)) {
    return empty(
      "account_mismatch",
      `provider 账户为 ${expected}，面板直连凭据为 ${c.user}，拒绝兜底以免跨账号取错正文`
    );
  }

  const result = await withAccountLock(c.user, async () => {
    const bodies = new Map<number, IcloudBody>();
    const localFailed = new Map<number, Exclude<IcloudBodyStatus, "ok">>();

    // 先吃缓存
    const todo: number[] = [];
    for (const uid of ids) {
      const hit = cacheGet(c.user, uid);
      if (hit) bodies.set(uid, hit);
      else todo.push(uid);
    }
    if (todo.length === 0) return { bodies, localFailed, status: "ok" as IcloudBodyStatus };

    const client = newClient(c, await ensureRelay());
    let lock: { release: () => void } | null = null;
    try {
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "IMAP 连接");

      lock = await client.getMailboxLock("INBOX");
      const work = (async () => {
        for await (const msg of client.fetch(todo.join(","), { source: true, size: true }, { uid: true })) {
          const uid = Number(msg.uid);
          const size = Number((msg as { size?: number }).size ?? 0);
          if (size > MAX_SOURCE_BYTES) {
            localFailed.set(uid, "too_large");
            continue;
          }
          if (!msg?.source) {
            localFailed.set(uid, "unavailable");
            continue;
          }
          try {
            const body = pick(await simpleParser(msg.source));
            bodies.set(uid, body);
            cacheSet(c.user, uid, body);
          } catch {
            localFailed.set(uid, "unavailable");
          }
        }
      })();

      await withTimeout(work, OVERALL_TIMEOUT_MS, "IMAP 读信");

      for (const uid of todo) {
        if (!bodies.has(uid) && !localFailed.has(uid)) localFailed.set(uid, "unavailable");
      }
      return { bodies, localFailed, status: "ok" as IcloudBodyStatus };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 认证失败不重试、不缓存：直接如实上抛状态
      const status: IcloudBodyStatus = /auth|login|credentials|invalid/i.test(message)
        ? "auth_failed"
        : "unavailable";
      lastError = message;
      console.warn("[icloud-imap] 取正文失败:", message);
      for (const uid of todo) if (!bodies.has(uid)) localFailed.set(uid, status);
      return { bodies, localFailed, status, reason: message };
    } finally {
      try { lock?.release(); } catch { /* ignore */ }
      try { await withTimeout(client.logout(), 3000, "IMAP 退出"); } catch { /* ignore */ }
    }
  });

  for (const [uid, why] of result.localFailed) failed.set(uid, why);
  return { bodies: result.bodies, status: result.status, failed, reason: lastError ?? undefined };
}

/** 自检：面板在运行环境里到底看到了什么（不回传任何凭据明文）。 */
export function icloudImapConfig() {
  const c = creds();
  const env = (k: string) => (process.env[k] ?? "").length;
  return {
    hasCreds: c !== null,
    emailLen: env("ICLOUD_EMAIL") || env("ICLOUD_IMAP_EMAIL"),
    passLen: env("ICLOUD_APP_PASSWORD") || env("ICLOUD_IMAP_APP_PASSWORD"),
    socksLen: env("SOCKS_PROXY") || env("ICLOUD_IMAP_SOCKS"),
    proxyConfigured: Boolean(proxyUrl()),
    relayPort,
    host: process.env.ICLOUD_IMAP_HOST || "imap.mail.me.com",
    port: Number(process.env.ICLOUD_IMAP_PORT || 993),
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    cacheEntries: cache.size,
    lastError
  };
}

/** 取单封正文（内部复用批量实现）。 */
export async function fetchIcloudBody(uid: number, options: FetchOptions = {}): Promise<IcloudBody | null> {
  const r = await fetchIcloudBodies([uid], options);
  return r.bodies.get(Number(uid)) ?? null;
}
