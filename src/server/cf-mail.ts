// 临时邮箱 provider 客户端（多实例）。按 provider.type 分流：
//   - "php": 自建 PHP 临时邮箱（webhostmost / edu，X-Admin-Password，action=external_*）—— 全功能
//   - "cf" : cloudflare_temp_email (dreamhunter2333) 标准接口。canonical 契约：
//       建址:    POST /admin/new_address (头 x-admin-auth) → {jwt, address, password, address_id}
//       读信:    GET  /api/parsed_mails?limit=&offset= (头 Authorization: Bearer <该址 jwt>) → {results, count}
//                解析字段 = {id, message_id, source, address, sender, subject, text, html, created_at, attachments}
//       发信:    POST /admin/send_mail (头 x-admin-auth) {from_mail, to_mail, subject, content, is_html} → {status:"ok"}
//       —— admin 无轻量「全量列地址」口子 → 列表走面板本地记账(app_settings cf.addresses.<id>)；
//          读某址先 mint 一把该址 jwt 再读 /api/parsed_mails。
//          ⚠ cfMint 依赖 new_address 同名幂等刷 jwt；真 canonical admin/new_address 对已存在地址可能非幂等，
//            待 roastalpha-cf 上线后改走 /admin/show_password/:id 或 /admin/mails?address= 实测校准。
import type { TempProvider } from "./temp-providers";
import { getSetting, setSetting } from "./db";

export type CfAlias = {
  address: string;
  local: string;
  createdAt: string | null;
  forwardEnabled?: boolean;
  forwardTo?: string[];
  id?: string | number;
};
export type CfMessageSummary = {
  uid: number;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  preview: string | null;
};
export type CfMessageDetail = CfMessageSummary & {
  recipientHint?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
};
export type CfSendInput = { from: string; to: string[]; subject?: string; body?: string; html?: boolean };
export type CfForwarding = { enabled: boolean; forwardTo: string[]; forwardedUids?: number[] };

function localOf(addr: string): string { return (addr || "").split("@")[0]; }
function fullAddr(provider: TempProvider, local: string): string {
  return local.includes("@") ? local : `${local}@${provider.domain}`;
}
function snippet(s: string | null | undefined, n = 140): string | null {
  if (!s) return null;
  const t = String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
}

/* ===================== php 类型 ===================== */
type PhpApiOptions = { method?: "GET" | "POST"; query?: Record<string, string | number | undefined>; body?: unknown; form?: Record<string, string | number | boolean | undefined> };
async function phpApi<T = any>(provider: TempProvider, action: string, options: PhpApiOptions = {}): Promise<T> {
  const url = new URL(provider.endpoint);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "X-Admin-Password": provider.password };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.form !== undefined) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.form)) if (v !== undefined) params.set(k, String(v));
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = params.toString(); init.method = "POST";
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `temp-mail HTTP ${res.status}`);
  return data as T;
}

/* ===================== cf 类型（cloudflare_temp_email 壳） ===================== */
// 本地记账：面板建过的地址前缀（cf 壳没有远端列表口子）
function cfNames(provider: TempProvider): string[] {
  try { const v = JSON.parse(getSetting(`cf.addresses.${provider.id}`) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function cfAddName(provider: TempProvider, local: string): void {
  const list = cfNames(provider);
  if (!list.includes(local)) { list.push(local); setSetting(`cf.addresses.${provider.id}`, JSON.stringify(list)); }
}
function cfRemoveName(provider: TempProvider, local: string): void {
  setSetting(`cf.addresses.${provider.id}`, JSON.stringify(cfNames(provider).filter((n) => n !== local)));
}

// 建/取地址：new_address 同名幂等 → 每次拿到新鲜 jwt（自动解决 24h 过期）
async function cfMint(provider: TempProvider, local: string): Promise<{ address: string; jwt: string; addressId?: string }> {
  const res = await fetch(provider.endpoint.replace(/\/+$/, "") + "/admin/new_address", {
    method: "POST",
    headers: { "x-admin-auth": provider.password, "content-type": "application/json" },
    body: JSON.stringify({ name: local, domain: provider.domain, enablePrefix: false })
  });
  const text = await res.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
  if (!res.ok || !j?.jwt) throw new Error(j?.error || j?.message || `cf new_address HTTP ${res.status}`);
  return { address: j.address || fullAddr(provider, local), jwt: j.jwt, addressId: j.address_id };
}

async function cfReadParsed(provider: TempProvider, local: string, limit = 50): Promise<any[]> {
  const { jwt } = await cfMint(provider, local);
  const res = await fetch(provider.endpoint.replace(/\/+$/, "") + `/api/parsed_mails?limit=${limit}`, {
    headers: { authorization: `Bearer ${jwt}` }
  });
  const text = await res.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
  if (!res.ok) throw new Error(j?.error || j?.message || `cf parsed_mails HTTP ${res.status}`);
  return Array.isArray(j) ? j : (j?.results ?? j?.mails ?? []);
}

// canonical cf parsed 字段：{id, sender, subject, text, html, source, address, created_at}
function cfMap(m: any, alias: string): CfMessageSummary {
  return {
    uid: Number(m.id ?? 0),
    subject: m.subject ?? null,
    from: m.sender ?? m.source ?? null,
    to: m.address ?? alias,
    date: m.created_at ?? null,
    preview: snippet(m.text)
  };
}

/* ===================== 对外统一接口（按 type 分流） ===================== */
export function cfDomain(provider: TempProvider): string { return provider.domain; }

export async function cfStatus(provider: TempProvider): Promise<any> {
  if (provider.type === "cf") {
    // mint 一个固定探针地址验证 x-admin-auth 通不通（幂等、无害）
    await cfMint(provider, "healthcheck");
    return { domain: provider.domain };
  }
  return phpApi(provider, "external_status");
}

export async function cfListAliases(provider: TempProvider): Promise<CfAlias[]> {
  if (provider.type === "cf") {
    return cfNames(provider).map((n) => ({ address: fullAddr(provider, n), local: n, createdAt: null }));
  }
  const data = await phpApi<{ aliases?: CfAlias[] }>(provider, "external_aliases");
  return data.aliases ?? [];
}

export async function cfInbox(provider: TempProvider, alias: string): Promise<CfMessageSummary[]> {
  if (provider.type === "cf") {
    const local = localOf(alias);
    cfAddName(provider, local); // 看过即记账，方便列表
    const mails = await cfReadParsed(provider, local);
    return mails.map((m) => cfMap(m, alias));
  }
  const data = await phpApi<{ messages?: CfMessageSummary[] }>(provider, "external_inbox", { query: { alias } });
  return data.messages ?? [];
}

// 出口列表用：带全量正文(text+html)，对齐 canonical /api/parsed_mails（列表也给完整 parsed，而非 preview 截断）。
// cf：一次 parsed_mails 全量本就含正文，零额外往返；php：摘要切片后逐封补全量。
export async function cfInboxRich(provider: TempProvider, alias: string, limit: number, offset: number): Promise<CfMessageDetail[]> {
  if (provider.type === "cf") {
    const mails = await cfReadParsed(provider, localOf(alias));
    return mails.slice(offset, offset + limit).map((m) => {
      const html: string | null = m.html ?? null;
      const body: string = m.text ?? "";
      return { ...cfMap(m, alias), bodyText: body || null, bodyHtml: html };
    });
  }
  const summaries = (await cfInbox(provider, alias)).slice(offset, offset + limit);
  const out: CfMessageDetail[] = [];
  for (const s of summaries) {
    try { out.push(await cfMessage(provider, alias, s.uid)); }
    catch { out.push({ ...s, bodyText: s.preview ?? null, bodyHtml: null }); }
  }
  return out;
}

export async function cfSent(provider: TempProvider, alias: string): Promise<CfMessageSummary[]> {
  if (provider.type === "cf") return []; // cf 壳无已发
  const data = await phpApi<{ messages?: CfMessageSummary[] }>(provider, "external_sent", { query: { alias } });
  return data.messages ?? [];
}

export async function cfSearch(
  provider: TempProvider,
  alias: string,
  query: { keyword?: string; from?: string; subject?: string; limit?: number }
): Promise<CfMessageSummary[]> {
  const messages = await cfInbox(provider, alias);
  const kw = query.keyword?.trim().toLowerCase();
  const fromQ = query.from?.trim().toLowerCase();
  const subjQ = query.subject?.trim().toLowerCase();
  return messages.filter((m) => {
    if (kw) { const hay = `${m.subject ?? ""}\n${m.from ?? ""}\n${m.preview ?? ""}`.toLowerCase(); if (!hay.includes(kw)) return false; }
    if (fromQ && !(m.from ?? "").toLowerCase().includes(fromQ)) return false;
    if (subjQ && !(m.subject ?? "").toLowerCase().includes(subjQ)) return false;
    return true;
  }).slice(0, query.limit ?? 50);
}

export async function cfMessage(provider: TempProvider, alias: string, uid: number): Promise<CfMessageDetail> {
  if (provider.type === "cf") {
    const mails = await cfReadParsed(provider, localOf(alias), 100);
    const m = mails.find((x) => Number(x.id) === Number(uid)) ?? {};
    const body: string = m.text ?? "";
    const html: string | null = m.html ?? null;
    return { ...cfMap(m, alias), bodyText: body || null, bodyHtml: html };
  }
  const data = await phpApi<{ message: CfMessageDetail }>(provider, "external_message", { query: { alias, uid } });
  return data.message;
}

export async function cfCreateAlias(provider: TempProvider, local: string): Promise<CfAlias> {
  if (provider.type === "cf") {
    const r = await cfMint(provider, local);
    cfAddName(provider, localOf(r.address));
    return { address: r.address, local: localOf(r.address), createdAt: null, id: r.addressId };
  }
  const data = await phpApi<{ alias?: CfAlias } & Partial<CfAlias>>(provider, "external_create_alias", { method: "POST", body: { local } });
  return data.alias ?? (data as CfAlias);
}

export async function cfDeleteAlias(provider: TempProvider, local: string): Promise<void> {
  if (provider.type === "cf") {
    // cf 壳无远端删除口子，仅从面板记账移除（地址本身是临时的，自然过期）
    cfRemoveName(provider, localOf(local));
    return;
  }
  await phpApi(provider, "external_delete_alias", { method: "POST", body: { local } });
}

export async function cfSend(provider: TempProvider, input: CfSendInput): Promise<any> {
  if (provider.type === "cf") {
    // canonical cf 管理员发信：POST /admin/send_mail (x-admin-auth)，字段 {from_mail,to_mail,subject,content,is_html} → {status:"ok"}
    const res = await fetch(provider.endpoint.replace(/\/+$/, "") + "/admin/send_mail", {
      method: "POST",
      headers: { "x-admin-auth": provider.password, "content-type": "application/json" },
      body: JSON.stringify({
        from_mail: input.from,
        to_mail: input.to.join(","),
        subject: input.subject ?? "",
        content: input.body ?? "",
        is_html: Boolean(input.html)
      })
    });
    const text = await res.text();
    let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
    if (!res.ok) throw new Error(j?.error || j?.message || `cf send_mail HTTP ${res.status}`);
    return j ?? { status: "ok" };
  }
  return phpApi(provider, "external_send", {
    method: "POST",
    body: { from: input.from, to: input.to, subject: input.subject ?? "", body: input.body ?? "", format: input.html ? "html" : "text" }
  });
}

export async function cfGlobalForwarding(provider: TempProvider): Promise<CfForwarding> {
  if (provider.type === "cf") return { enabled: false, forwardTo: [] };
  const data = await phpApi<{ forwarding: CfForwarding }>(provider, "external_global_forwarding");
  return data.forwarding;
}

export async function cfUpdateAliasForwarding(provider: TempProvider, address: string, enabled: boolean, forwardTo: string[]): Promise<CfAlias[]> {
  if (provider.type === "cf") throw new Error("cloudflare_temp_email 壳不支持转发设置");
  const data = await phpApi<{ aliases?: CfAlias[] }>(provider, "external_update_forwarding", {
    form: { address, enabled: enabled ? 1 : 0, forwardTo: forwardTo.join(",") }
  });
  return data.aliases ?? [];
}

export async function cfUpdateGlobalForwarding(provider: TempProvider, enabled: boolean, forwardTo: string[]): Promise<CfForwarding> {
  if (provider.type === "cf") throw new Error("cloudflare_temp_email 壳不支持转发设置");
  const data = await phpApi<{ forwarding: CfForwarding }>(provider, "external_update_global_forwarding", {
    form: { enabled: enabled ? 1 : 0, forwardTo: forwardTo.join(",") }
  });
  return data.forwarding;
}
