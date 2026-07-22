import type { Response } from "express";
import type { Scope } from "./config.ts";

const styles = `
:root{color-scheme:dark;--ink:#eefaf4;--muted:#8fa89c;--line:rgba(198,255,224,.14);--panel:rgba(9,25,19,.78);--mint:#80f0b4;--mint-strong:#3ddd8a;--amber:#ffc66d;--danger:#ff8b82;--shadow:0 30px 100px rgba(0,0,0,.38)}
*{box-sizing:border-box}
html{min-height:100%;background:#06100c}
body{min-height:100vh;margin:0;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(circle at 12% 8%,rgba(33,160,99,.18),transparent 27rem),radial-gradient(circle at 88% 88%,rgba(47,111,91,.16),transparent 30rem),#06100c}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.3;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(to bottom,black,transparent 80%)}
a{color:inherit}
.shell{position:relative;width:min(1120px,calc(100% - 40px));margin:0 auto;padding:30px 0 52px}
.nav{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:clamp(54px,10vh,116px)}
.brand{display:inline-flex;align-items:center;gap:11px;text-decoration:none;font-size:14px;font-weight:760;letter-spacing:.04em}
.brand-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(128,240,180,.35);border-radius:11px;background:rgba(128,240,180,.08);box-shadow:inset 0 0 18px rgba(128,240,180,.08);color:var(--mint);font:700 14px ui-monospace,SFMono-Regular,Menlo,monospace}
.nav-link{color:var(--muted);font-size:13px;text-decoration:none;transition:color .18s ease}.nav-link:hover{color:var(--ink)}
.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:clamp(48px,8vw,100px);align-items:end}
.eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 20px;color:var(--mint);font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase}
.eyebrow:before{content:"";width:28px;height:1px;background:currentColor}
h1{max-width:760px;margin:0;font-size:clamp(48px,8vw,94px);line-height:.93;letter-spacing:-.065em;font-weight:720}
.lede{max-width:660px;margin:28px 0 0;color:#aec2b8;font-size:clamp(17px,2vw,21px);line-height:1.65;letter-spacing:-.015em}
.status-card,.panel{border:1px solid var(--line);border-radius:24px;background:linear-gradient(145deg,rgba(15,38,28,.86),rgba(7,21,15,.72));box-shadow:var(--shadow);backdrop-filter:blur(18px)}
.status-card{padding:25px}.status-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:21px;border-bottom:1px solid var(--line)}
.status-label{color:var(--muted);font-size:12px;letter-spacing:.12em;text-transform:uppercase}.online{display:inline-flex;align-items:center;gap:8px;color:var(--mint);font-size:13px;font-weight:700}.online:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--mint);box-shadow:0 0 16px var(--mint)}
.endpoint{margin-top:21px}.endpoint span{display:block;margin-bottom:9px;color:var(--muted);font-size:12px}.endpoint code{font:600 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d7f5e5;overflow-wrap:anywhere}
.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:clamp(70px,11vw,130px)}
.feature{min-height:190px;padding:24px;border-top:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.018),transparent)}
.feature-index{color:var(--mint);font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace}.feature h2{margin:50px 0 10px;font-size:17px;letter-spacing:-.02em}.feature p{margin:0;color:var(--muted);font-size:14px;line-height:1.65}
.page-grid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(320px,1.2fr);gap:clamp(42px,8vw,96px);align-items:start;max-width:980px;margin:0 auto}
.page-title{margin:0;font-size:clamp(42px,6vw,70px);line-height:1;letter-spacing:-.055em}.page-copy{margin:23px 0 0;color:#a7bdb2;font-size:17px;line-height:1.7}
.panel{padding:clamp(24px,5vw,42px)}
.client{display:flex;align-items:center;gap:15px;padding-bottom:24px;border-bottom:1px solid var(--line)}
.client-icon{display:grid;place-items:center;flex:0 0 auto;width:50px;height:50px;border-radius:16px;background:linear-gradient(145deg,rgba(128,240,180,.2),rgba(128,240,180,.05));border:1px solid rgba(128,240,180,.25);color:var(--mint);font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace}
.client-meta span{display:block;color:var(--muted);font-size:12px;margin-bottom:5px}.client-meta strong{font-size:17px;letter-spacing:-.02em}
.scope-heading{margin:26px 0 13px;color:var(--muted);font-size:12px;letter-spacing:.12em;text-transform:uppercase}
.scopes{display:grid;gap:9px;margin:0;padding:0;list-style:none}.scope{display:flex;gap:13px;padding:14px;border:1px solid rgba(255,255,255,.07);border-radius:14px;background:rgba(255,255,255,.018)}
.scope-check{display:grid;place-items:center;flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:rgba(128,240,180,.11);color:var(--mint);font-size:12px}.scope-copy strong{display:block;margin:1px 0 4px;font-size:13px}.scope-copy span{display:block;color:var(--muted);font-size:12px;line-height:1.5}.scope-copy code{color:#bdd6c9;font-size:11px}
.auth-form{margin-top:26px;padding-top:25px;border-top:1px solid var(--line)}label{display:block;margin-bottom:9px;color:#c7d9d0;font-size:13px;font-weight:650}
input{width:100%;height:52px;padding:0 15px;border:1px solid rgba(214,255,232,.18);border-radius:13px;outline:none;background:rgba(0,0,0,.22);color:var(--ink);font:inherit;transition:border-color .18s ease,box-shadow .18s ease}input:focus{border-color:rgba(128,240,180,.7);box-shadow:0 0 0 4px rgba(128,240,180,.09)}
.error-banner{margin:0 0 18px;padding:13px 14px;border:1px solid rgba(255,139,130,.24);border-radius:12px;background:rgba(255,139,130,.08);color:#ffc2bd;font-size:13px;line-height:1.5}
.actions{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:14px}button,.button{min-height:49px;padding:0 20px;border-radius:13px;border:1px solid transparent;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-grid;place-items:center;transition:transform .16s ease,filter .16s ease}button:hover,.button:hover{transform:translateY(-1px);filter:brightness(1.06)}.primary{background:var(--mint);color:#052213}.secondary{border-color:var(--line);background:transparent;color:#b7cbc1}
.form-note{margin:15px 0 0;color:#718b7e;font-size:11px;line-height:1.55}
.security-list{display:grid;gap:12px}.security-item{padding:21px;border:1px solid var(--line);border-radius:17px;background:rgba(255,255,255,.018)}.security-item small{display:block;color:var(--mint);font:600 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.security-item h2{margin:13px 0 7px;font-size:16px}.security-item p{margin:0;color:var(--muted);font-size:13px;line-height:1.65}
.error-code{color:var(--danger);font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em}.error-page .page-title{max-width:650px}.error-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:30px}.error-actions .button{min-width:140px}
.footer{display:flex;justify-content:space-between;gap:20px;margin-top:90px;padding-top:22px;border-top:1px solid rgba(255,255,255,.07);color:#688176;font-size:11px}.footer-links{display:flex;gap:18px}.footer a{text-decoration:none}.footer a:hover{color:#b8cec3}
@media(max-width:760px){.shell{width:min(100% - 28px,1120px);padding-top:20px}.nav{margin-bottom:58px}.hero,.page-grid{grid-template-columns:1fr}.hero{gap:42px}.feature-grid{grid-template-columns:1fr}.feature{min-height:0}.feature h2{margin-top:28px}.page-grid{gap:34px}.panel{border-radius:20px}.footer{margin-top:60px;flex-direction:column}.actions{grid-template-columns:1fr}.secondary{order:2}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

const scopeDetails: Record<Scope, { title: string; description: string }> = {
  "workspace:read": {
    title: "Read workspace",
    description:
      "View registered projects, files, search results, and Git state.",
  },
  "workspace:write": {
    title: "Change workspace",
    description: "Apply patches, register projects, and create Git commits.",
  },
  "command:run": {
    title: "Run commands",
    description: "Execute foreground and background processes in the runner.",
  },
  "command:network": {
    title: "Use the network",
    description:
      "Allow approved commands to communicate with external services.",
  },
};

export function sendPage(
  res: Response,
  status: number,
  body: string,
  formActions: string[] = [],
): Response {
  const allowedForms =
    formActions.length > 0 ? formActions.join(" ") : "'none'";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${allowedForms}; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).type("html").send(body);
}

export function landingPage(publicBaseUrl: string): string {
  const endpoint = `${publicBaseUrl}/mcp`;
  return shell(
    "Dev MCP — Secure workspace bridge",
    `<main><section class="hero"><div><p class="eyebrow">Private developer infrastructure</p><h1>Your workspace, within reach.</h1><p class="lede">A deliberately small bridge between ChatGPT and a dedicated development runner. Files stay in your workspace; authorization stays under your control.</p></div><aside class="status-card"><div class="status-row"><span class="status-label">Gateway status</span><span class="online">Online</span></div><div class="endpoint"><span>Streamable HTTP endpoint</span><code>${escapeHtml(endpoint)}</code></div></aside></section><section class="feature-grid" aria-label="Platform features"><article class="feature"><span class="feature-index">01 / AUTH</span><h2>Explicit access</h2><p>OAuth 2.1, PKCE, short-lived access tokens, and scope checks on every tool call.</p></article><article class="feature"><span class="feature-index">02 / BOUNDARY</span><h2>Isolated execution</h2><p>The public gateway never mounts the workspace. Runner communication stays on a Unix socket.</p></article><article class="feature"><span class="feature-index">03 / CONTROL</span><h2>Visible intent</h2><p>Read, write, destructive, and network-aware tools remain distinct for clear approvals.</p></article></section></main>`,
  );
}

export function securityPage(): string {
  return shell(
    "Security — Dev MCP",
    `<main class="page-grid"><section><p class="eyebrow">Security model</p><h1 class="page-title">Small surface.<br>Strong boundary.</h1><p class="page-copy">The gateway, workspace runner, and TLS edge are separate services with narrowly defined responsibilities.</p></section><section class="security-list"><article class="security-item"><small>AUTHENTICATION</small><h2>OAuth with proof of possession</h2><p>Authorization Code with PKCE, one-time codes, hashed tokens, revocation, and per-tool scopes.</p></article><article class="security-item"><small>FILESYSTEM</small><h2>One controlled mount</h2><p>Only the runner sees the workspace. The gateway has no workspace, Docker socket, host home, SSH keys, or Codex state.</p></article><article class="security-item"><small>RUNTIME</small><h2>Restricted containers</h2><p>Read-only root filesystems, dropped capabilities, non-root users, and no-new-privileges reduce the impact of a compromised process.</p></article><article class="security-item"><small>NETWORK</small><h2>Separated paths</h2><p>The gateway and runner do not share a Docker network. Tool traffic crosses a dedicated Unix socket with audited requests.</p></article></section></main>`,
  );
}

export function authorizationPage(options: {
  transaction: string;
  clientName: string;
  scopes: Scope[];
  authorizationEndpoint: string;
  error?: string;
}): string {
  const clientName = escapeHtml(options.clientName);
  const clientInitials = escapeHtml(initials(options.clientName));
  const scopeItems = options.scopes
    .map((scope) => {
      const detail = scopeDetails[scope];
      return `<li class="scope"><span class="scope-check">✓</span><span class="scope-copy"><strong>${escapeHtml(detail.title)}</strong><span>${escapeHtml(detail.description)}</span><code>${escapeHtml(scope)}</code></span></li>`;
    })
    .join("");
  const error = options.error
    ? `<p class="error-banner" role="alert">${escapeHtml(options.error)}</p>`
    : "";
  return shell(
    `Authorize ${options.clientName} — Dev MCP`,
    `<main class="page-grid"><section><p class="eyebrow">Authorization request</p><h1 class="page-title">Connect to your workspace.</h1><p class="page-copy">Review the requested access before allowing this client to use Dev MCP on your behalf.</p></section><section class="panel"><div class="client"><span class="client-icon">${clientInitials}</span><span class="client-meta"><span>Requesting client</span><strong>${clientName}</strong></span></div><p class="scope-heading">Requested access</p><ul class="scopes">${scopeItems}</ul><form class="auth-form" method="post" action="${escapeHtml(options.authorizationEndpoint)}">${error}<input type="hidden" name="transaction" value="${escapeHtml(options.transaction)}"><label for="password">Administrator password</label><input id="password" type="password" name="password" required autocomplete="current-password" autofocus><div class="actions"><button class="primary" name="decision" value="allow" type="submit">Allow access</button><button class="secondary" name="decision" value="deny" type="submit" formnovalidate>Deny</button></div><p class="form-note">The password is verified by this gateway and is never sent to the requesting client.</p></form></section></main>`,
  );
}

export function errorPage(options: {
  status: number;
  title: string;
  message: string;
  code?: string;
}): string {
  const code = options.code ?? `HTTP ${options.status}`;
  return shell(
    `${options.title} — Dev MCP`,
    `<main class="error-page"><p class="error-code">${escapeHtml(code)}</p><h1 class="page-title">${escapeHtml(options.title)}</h1><p class="page-copy">${escapeHtml(options.message)}</p><div class="error-actions"><a class="button primary" href="/">Return home</a><a class="button secondary" href="/security">Security model</a></div></main>`,
  );
}

function shell(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#06100c"><meta name="description" content="Dev MCP is a secure bridge between ChatGPT and a dedicated development workspace."><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><div class="shell"><header class="nav"><a class="brand" href="/"><span class="brand-mark">&gt;_</span><span>DEV MCP</span></a><a class="nav-link" href="/security">Security model ↗</a></header>${content}<footer class="footer"><span>Private workspace infrastructure</span><span class="footer-links"><a href="/security">Security</a><a href="/.well-known/oauth-protected-resource">Metadata</a></span></footer></div></body></html>`;
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "APP";
  }
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
