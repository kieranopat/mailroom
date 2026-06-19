import { useState, useEffect, useRef, useCallback } from "react";

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const gmailLink = (threadId) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

// ------------------------------------------------------------------
// Gmail REST helpers
// ------------------------------------------------------------------
async function gfetch(token, path, opts = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${GMAIL}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) throw new Error("AUTH_EXPIRED");
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail ${res.status}: ${body.slice(0, 140)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function listMessageIds(token, q, max = 40) {
  const data = await gfetch(
    token,
    `/messages?q=${encodeURIComponent(q)}&maxResults=${max}`
  );
  return (data.messages || []).map((m) => m.id);
}

function header(meta, name) {
  const h = (meta.payload?.headers || []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : "";
}

function parseFrom(from) {
  const m = from.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/(^"|"$)/g, "") || m[2], email: m[2].toLowerCase() };
  return { name: from, email: from.toLowerCase() };
}

async function fetchMeta(token, ids) {
  const out = [];
  const chunk = 10;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = await Promise.all(
      ids.slice(i, i + chunk).map((id) =>
        gfetch(
          token,
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
        )
      )
    );
    for (const m of part) {
      const f = parseFrom(header(m, "From"));
      out.push({
        id: m.id,
        threadId: m.threadId,
        from: f.name,
        email: f.email,
        subject: header(m, "Subject"),
        date: new Date(Number(m.internalDate)).toISOString(),
        snippet: (m.snippet || "").slice(0, 140),
      });
    }
  }
  return out;
}

async function batchArchive(token, messageIds) {
  if (!messageIds.length) return 0;
  await gfetch(token, `/messages/batchModify`, {
    method: "POST",
    body: JSON.stringify({ ids: messageIds, removeLabelIds: ["INBOX"] }),
  });
  return messageIds.length;
}

// ------------------------------------------------------------------
// AI summarize via our serverless function
// ------------------------------------------------------------------
async function summarize(mode, payload) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Summarize failed (${res.status})`);
    return data;
  } finally {
    clearTimeout(tid);
  }
}

// ------------------------------------------------------------------
// Misc
// ------------------------------------------------------------------
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 36e5;
    if (diff < 24)
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------
// UI atoms
// ------------------------------------------------------------------
function Spinner({ label }) {
  return (
    <div className="spin-wrap">
      <div className="spinner" aria-hidden="true" />
      <span className="spin-label">{label}</span>
    </div>
  );
}

function ErrorBox({ msg, onRetry }) {
  return (
    <div className="errbox">
      <p>{msg}</p>
      <button className="btn ghost" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

function Postmark() {
  const now = new Date();
  const top = now
    .toLocaleDateString([], { month: "short", day: "numeric" })
    .toUpperCase();
  const year = String(now.getFullYear());
  return (
    <div className="postmark" aria-hidden="true">
      <svg viewBox="0 0 150 64" width="150" height="64">
        <g stroke="#C8442E" strokeWidth="1.6" fill="none" opacity="0.85">
          <path d="M2 22 q 10 -5 20 0 t 20 0 t 20 0 t 20 0" />
          <path d="M2 32 q 10 -5 20 0 t 20 0 t 20 0 t 20 0" />
          <path d="M2 42 q 10 -5 20 0 t 20 0 t 20 0 t 20 0" />
          <g transform="rotate(-8 118 32)">
            <circle cx="118" cy="32" r="27" />
            <circle cx="118" cy="32" r="21" strokeWidth="1" />
            <text x="118" y="29" textAnchor="middle" fill="#C8442E" stroke="none"
              fontFamily="'IBM Plex Mono',monospace" fontSize="9.5" fontWeight="600" letterSpacing="1">
              {top}
            </text>
            <text x="118" y="41" textAnchor="middle" fill="#C8442E" stroke="none"
              fontFamily="'IBM Plex Mono',monospace" fontSize="9.5" fontWeight="600" letterSpacing="2">
              {year}
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------
// Sections
// ------------------------------------------------------------------
function ImportantSection({ state, load }) {
  if (state.loading) return <Spinner label="Reading your inbox…" />;
  if (state.error) return <ErrorBox msg={state.error} onRetry={load} />;
  if (!state.data) return null;
  if (!state.data.length)
    return <Empty>Nothing needs your attention right now.</Empty>;
  return (
    <ul className="list">
      {state.data.map((m) => (
        <li key={m.id} className="item">
          <div className="item-top">
            <span className="from">{m.from}</span>
            <span className="when">{fmtDate(m.date)}</span>
          </div>
          <a className="subject" href={gmailLink(m.id)} target="_blank" rel="noreferrer">
            {m.subject}
          </a>
          <p className="note">{m.note}</p>
        </li>
      ))}
    </ul>
  );
}

function DigestGroup({ title, items }) {
  if (!items || !items.length) return null;
  return (
    <div className="dgroup">
      <h3 className="dgroup-title">{title}</h3>
      <ul className="list">
        {items.map((m) => (
          <li key={m.id} className="item">
            <div className="item-top">
              <span className="from">{m.src}</span>
              <span className="when">{fmtDate(m.date)}</span>
            </div>
            <p className="note">{m.hl}</p>
            <a className="readmore" href={gmailLink(m.id)} target="_blank" rel="noreferrer">
              Read it →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DigestSection({ state, load }) {
  if (state.loading) return <Spinner label="Building your digest…" />;
  if (state.error) return <ErrorBox msg={state.error} onRetry={load} />;
  if (!state.data) return null;
  const d = state.data;
  const empty =
    !(d.h24 && d.h24.length) && !(d.week && d.week.length) && !(d.older && d.older.length);
  if (empty) return <Empty>No newsletters waiting. Quiet day.</Empty>;
  return (
    <div>
      <DigestGroup title="Last 24 hours" items={d.h24} />
      <DigestGroup title="Last week" items={d.week} />
      <DigestGroup title="Older" items={d.older} />
    </div>
  );
}

function SenderRow({ s, token, onAuthExpired }) {
  const [status, setStatus] = useState("idle");
  const [count, setCount] = useState(null);
  const [more, setMore] = useState(false);

  const run = async () => {
    setStatus("working");
    try {
      const ids = await listMessageIds(token, `in:inbox from:${s.email}`, 100);
      const n = await batchArchive(token, ids);
      setCount(n);
      setMore(ids.length === 100);
      setStatus("done");
    } catch (e) {
      if (e.message === "AUTH_EXPIRED") onAuthExpired();
      setStatus("error");
    }
  };

  return (
    <li className="item">
      <div className="item-top">
        <span className="from">{s.sender}</span>
        <span className="count">{s.n}+</span>
      </div>
      <span className="addr">{s.email}</span>
      <p className="note">{s.sum}</p>
      <div className="row-actions">
        {status === "idle" && (
          <button className="btn" onClick={() => setStatus("confirm")}>
            Archive all
          </button>
        )}
        {status === "confirm" && (
          <>
            <button className="btn danger" onClick={run}>
              Confirm archive
            </button>
            <button className="btn ghost" onClick={() => setStatus("idle")}>
              Cancel
            </button>
          </>
        )}
        {status === "working" && <Spinner label="Archiving…" />}
        {status === "done" && (
          <span className="done-msg">
            Archived {count}
            {more ? (
              <button className="btn ghost inline" onClick={run}>
                more remain — run again
              </button>
            ) : (
              " — all clear"
            )}
          </span>
        )}
        {status === "error" && (
          <span className="done-msg err">
            Couldn't archive.{" "}
            <button className="btn ghost inline" onClick={run}>
              Retry
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

function SubsSection({ state, load, token, onAuthExpired }) {
  if (state.loading) return <Spinner label="Sorting subscriptions…" />;
  if (state.error) return <ErrorBox msg={state.error} onRetry={load} />;
  if (!state.data) return null;
  if (!state.data.length)
    return <Empty>No subscription clutter found. Inbox zero is close.</Empty>;
  return (
    <ul className="list">
      {state.data.map((s) => (
        <SenderRow key={s.email} s={s} token={token} onAuthExpired={onAuthExpired} />
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------
// Section data loaders
// ------------------------------------------------------------------
async function loadImportantData(token) {
  const ids = await listMessageIds(
    token,
    "in:inbox -category:promotions -category:social",
    30
  );
  if (!ids.length) return [];
  const meta = await fetchMeta(token, ids);
  const emails = meta.map((m) => ({
    id: m.threadId,
    from: m.from,
    email: m.email,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
  }));
  return summarize("important", { emails });
}

async function loadDigestData(token) {
  const ids = await listMessageIds(
    token,
    "in:inbox (category:updates OR category:promotions OR unsubscribe)",
    40
  );
  if (!ids.length) return { h24: [], week: [], older: [] };
  const meta = await fetchMeta(token, ids);
  const emails = meta.map((m) => ({
    id: m.threadId,
    from: m.from,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
  }));
  return summarize("digest", { emails });
}

async function loadSubsData(token) {
  const ids = await listMessageIds(token, "in:inbox category:promotions", 60);
  if (!ids.length) return [];
  const meta = await fetchMeta(token, ids);
  // Group by sender client-side (deterministic), AI only writes the blurbs.
  const groups = {};
  for (const m of meta) {
    if (!groups[m.email])
      groups[m.email] = { sender: m.from, email: m.email, n: 0, subjects: [] };
    groups[m.email].n += 1;
    if (groups[m.email].subjects.length < 3)
      groups[m.email].subjects.push(m.subject);
  }
  const list = Object.values(groups)
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);
  let sums = {};
  try {
    sums = await summarize("subs", {
      groups: list.map((g) => ({ email: g.email, sender: g.sender, subjects: g.subjects })),
    });
  } catch {
    // Summaries are a nice-to-have; show groups regardless.
  }
  return list.map((g) => ({
    sender: g.sender,
    email: g.email,
    n: g.n,
    sum: sums[g.email] || g.subjects[0] || "",
  }));
}

// ------------------------------------------------------------------
// App
// ------------------------------------------------------------------
const TABS = [
  { key: "important", label: "Important" },
  { key: "digest", label: "Digest" },
  { key: "subs", label: "Subscriptions" },
];

export default function App() {
  const [token, setToken] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState(null);
  const tokenClient = useRef(null);

  const [tab, setTab] = useState("important");
  const [sections, setSections] = useState({
    important: { loading: false, data: null, error: null },
    digest: { loading: false, data: null, error: null },
    subs: { loading: false, data: null, error: null },
  });

  // Load Google Identity Services
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      setAuthError("Missing VITE_GOOGLE_CLIENT_ID — see README setup steps.");
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      tokenClient.current = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GMAIL_SCOPE,
        callback: (resp) => {
          if (resp.error) setAuthError(resp.error_description || resp.error);
          else {
            setAuthError(null);
            setToken(resp.access_token);
          }
        },
      });
      setAuthReady(true);
    };
    s.onerror = () => setAuthError("Couldn't load Google sign-in script.");
    document.head.appendChild(s);
  }, []);

  const signIn = () => {
    if (tokenClient.current)
      tokenClient.current.requestAccessToken({ prompt: token ? "" : "consent" });
  };

  const onAuthExpired = useCallback(() => setToken(null), []);

  const setSection = (key, patch) =>
    setSections((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const load = useCallback(
    async (key, force = false) => {
      if (!token) return;
      let proceed = false;
      setSections((prev) => {
        if (!force && (prev[key].loading || prev[key].data)) return prev;
        proceed = true;
        return { ...prev, [key]: { loading: true, data: null, error: null } };
      });
      if (!proceed) return;
      try {
        const data =
          key === "important"
            ? await loadImportantData(token)
            : key === "digest"
            ? await loadDigestData(token)
            : await loadSubsData(token);
        setSection(key, { loading: false, data, error: null });
      } catch (e) {
        if (e.message === "AUTH_EXPIRED") {
          onAuthExpired();
          setSection(key, {
            loading: false,
            data: null,
            error: "Your Google session expired — sign in again.",
          });
        } else {
          setSection(key, {
            loading: false,
            data: null,
            error: e.message || "Something went wrong.",
          });
        }
      }
    },
    [token, onAuthExpired]
  );

  useEffect(() => {
    if (token) load(tab);
  }, [tab, token, load]);

  return (
    <div className="app">
      <style>{CSS}</style>
      <header className="hdr">
        <div className="hdr-row">
          <h1 className="brand">Mailroom</h1>
          <Postmark />
        </div>
        <div className="hdr-rule" aria-hidden="true" />
      </header>

      {!token ? (
        <div className="gate">
          <p className="gate-copy">
            Your inbox, sorted: what matters, what's news, and what can go.
          </p>
          <button className="btn big" onClick={signIn} disabled={!authReady}>
            {authReady ? "Connect Gmail" : "Loading…"}
          </button>
          <p className="gate-fine">
            Read &amp; archive access only. Nothing is sent anywhere except
            subject lines to Claude for sorting.
          </p>
          {authError && <p className="gate-err">{authError}</p>}
        </div>
      ) : (
        <>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={"tab" + (tab === t.key ? " active" : "")}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="sec-head">
            <h2 className="sec-title">
              {tab === "important"
                ? "Needs your attention"
                : tab === "digest"
                ? "Newsletter digest"
                : "Subscription traffic"}
            </h2>
            <button className="refresh" onClick={() => load(tab, true)}>
              ↻ refresh
            </button>
          </div>

          {tab === "important" && (
            <ImportantSection
              state={sections.important}
              load={() => load("important", true)}
            />
          )}
          {tab === "digest" && (
            <DigestSection state={sections.digest} load={() => load("digest", true)} />
          )}
          {tab === "subs" && (
            <SubsSection
              state={sections.subs}
              load={() => load("subs", true)}
              token={token}
              onAuthExpired={onAuthExpired}
            />
          )}
        </>
      )}

      <p className="foot">sorted by Claude · links open in Gmail</p>
    </div>
  );
}

// ------------------------------------------------------------------
// Styles
// ------------------------------------------------------------------
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

:root{
  --ink:#1C2433; --paper:#F7F6F2; --card:#FFFFFF;
  --red:#D7402B; --blue:#2B4ED7; --muted:#8A8F98; --hair:#E5E2DA;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body,#root{height:100%;background:#F7F6F2}
.app{
  min-height:100vh;background:var(--paper);color:var(--ink);
  font-family:'Public Sans',system-ui,sans-serif;font-size:15px;line-height:1.45;
  max-width:560px;margin:0 auto;padding-bottom:48px;
}
.hdr{padding:14px 18px 0;background:var(--paper);position:sticky;top:0;z-index:5}
.hdr-row{display:flex;align-items:center;justify-content:space-between;min-height:64px}
.brand{font-family:'Fraunces',serif;font-weight:600;font-size:27px;letter-spacing:-0.01em}
.postmark{flex-shrink:0;margin-right:-6px}
.hdr-rule{height:1px;background:var(--hair);margin-top:6px}
.tabs{display:flex;gap:6px;padding:10px 18px 4px;background:var(--paper)}
.tab{
  flex:1;border:1px solid var(--hair);background:var(--card);color:var(--muted);
  font-family:'Public Sans',sans-serif;font-weight:600;font-size:13px;
  padding:9px 0;border-radius:9px;cursor:pointer;
}
.tab.active{color:var(--paper);background:var(--ink);border-color:var(--ink)}
.tab:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.sec-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px 6px}
.sec-title{font-family:'Fraunces',serif;font-weight:600;font-size:19px}
.refresh{
  border:none;background:none;color:var(--blue);font-size:12px;font-weight:600;
  font-family:'IBM Plex Mono',monospace;cursor:pointer;padding:6px;
}
.list{list-style:none;padding:0 18px}
.item{background:var(--card);border:1px solid var(--hair);border-radius:12px;padding:13px 14px;margin-bottom:10px}
.item-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.from{font-weight:600;font-size:14px}
.when,.count{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);white-space:nowrap}
.count{color:var(--red);font-weight:500}
.addr{font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--muted);word-break:break-all}
.subject{display:block;margin-top:3px;color:var(--ink);font-weight:500;text-decoration:none}
.subject:active{opacity:.6}
.note{margin-top:4px;color:#4A5160;font-size:13.5px}
.readmore{display:inline-block;margin-top:6px;color:var(--blue);font-weight:600;font-size:13px;text-decoration:none}
.dgroup-title{
  font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--muted);padding:10px 18px 8px;
}
.row-actions{margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{
  border:1px solid var(--ink);background:var(--ink);color:var(--paper);
  font-weight:600;font-size:13px;padding:8px 14px;border-radius:9px;cursor:pointer;
  font-family:'Public Sans',sans-serif;
}
.btn.big{font-size:15px;padding:12px 22px}
.btn:disabled{opacity:.5}
.btn.danger{background:var(--red);border-color:var(--red)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--hair)}
.btn.inline{padding:4px 8px;font-size:12px;margin-left:6px}
.btn:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.done-msg{font-size:13px;font-weight:500;color:#2E7D4F}
.done-msg.err{color:var(--red)}
.spin-wrap{display:flex;align-items:center;gap:10px;padding:26px 18px;color:var(--muted)}
.spinner{
  width:16px;height:16px;border:2px solid var(--hair);border-top-color:var(--ink);
  border-radius:50%;animation:rot .8s linear infinite;
}
@keyframes rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.spinner{animation:none}}
.spin-label{font-size:13px}
.empty{padding:30px 18px;color:var(--muted);font-size:14px}
.errbox{padding:20px 18px;color:var(--red);font-size:14px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.gate{padding:40px 24px;display:flex;flex-direction:column;gap:16px;align-items:flex-start}
.gate-copy{font-family:'Fraunces',serif;font-size:21px;font-weight:500;line-height:1.35}
.gate-fine{font-size:12.5px;color:var(--muted)}
.gate-err{font-size:13px;color:var(--red)}
.foot{padding:24px 18px 0;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--muted);text-align:center}
`;
