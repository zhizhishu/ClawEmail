// 邮件 HTML 包装：注入排版 + 柔纸底，避免 iframe 里渲染成纯白板。
// 从 InboxView 抽出共用，ClawEmail 的 alias 详情页也用同一套。
// 给邮件 HTML 注入一套排版 + 柔纸底，避免渲染成"纯白板/白色404"
export function wrapEmailHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0}
  body{
    padding:24px 28px;
    font-family:"Nunito","PingFang SC","Microsoft YaHei",-apple-system,system-ui,"Segoe UI",sans-serif;
    font-size:14.5px; line-height:1.75; color:#283142;
    background:#ecf0f6; /* 柔纸底，不刺眼纯白 */
    word-break:break-word; overflow-wrap:anywhere;
  }
  img{max-width:100%;height:auto;border-radius:10px}
  a{color:#3a72b8;text-decoration:underline;text-underline-offset:2px}
  blockquote{margin:10px 0;padding:4px 0 4px 14px;border-left:3px solid #c9d2e0;color:#5b6675}
  p{margin:0 0 12px} pre{white-space:pre-wrap;word-break:break-word}
  table{max-width:100%} hr{border:none;border-top:1px solid #e2e7f0;margin:16px 0}
</style></head><body>${html}</body></html>`;
}
