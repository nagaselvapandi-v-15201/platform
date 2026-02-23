import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import axios from "axios";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const CATALYST_API_BASE =
  import.meta.env.VITE_API_BASE ??
  "https://platform-60065907345.development.catalystserverless.in/server/FunctionFetch1/execute";
const CACHE_KEY_PREFIX = "failure_logs_cache_";
const CACHE_EXPIRY_MS = 5 * 60 * 1000;
const PAGE_SIZE = 200;

const EXCEPTION_PATTERNS = [
  { patterns: [/NullPointerException/i, /NPE/], title: "Null Pointer Exception", rootCause: "A variable or object reference is `null` when the code tries to use it.", fix: "Add a null check before using the object. Trace back through the stack to find where the variable is expected to be set but isn't.", severity: "high" },
  { patterns: [/ClassNotFoundException/i, /NoClassDefFoundError/i], title: "Class Not Found", rootCause: "A required class is missing from the classpath at runtime.", fix: "Verify all required dependencies/JARs are included in the deployment.", severity: "critical" },
  { patterns: [/ConnectionTimeout/i, /SocketTimeoutException/i, /ConnectException/i, /Connection refused/i, /Connection timed out/i], title: "Connection / Timeout Error", rootCause: "The server could not establish or maintain a network connection within the allowed time.", fix: "Check if the target service is reachable. Review timeout config values.", severity: "high" },
  { patterns: [/SQLException/i, /ORA-\d+/i, /MySQLException/i, /DataAccessException/i, /JDBCException/i, /deadlock/i, /duplicate key/i, /Duplicate entry/i], title: "Database Error", rootCause: "A database operation failed.", fix: "Check the SQL state / error code for specifics.", severity: "high" },
  { patterns: [/OutOfMemoryError/i, /Java heap space/i, /GC overhead limit/i, /PermGen space/i], title: "Out of Memory Error", rootCause: "The JVM ran out of heap memory.", fix: "Increase JVM heap (-Xmx). Profile for memory leaks.", severity: "critical" },
  { patterns: [/StackOverflowError/i, /stack overflow/i], title: "Stack Overflow", rootCause: "Infinite or excessively deep recursion.", fix: "Find the recursive method and add a proper base case.", severity: "high" },
  { patterns: [/400/, /Bad Request/i, /InvalidParameter/i, /ValidationException/i, /ConstraintViolation/i], title: "Bad Request / Validation Error (400)", rootCause: "The request contained invalid, missing, or malformed parameters.", fix: "Review the request payload against the API contract.", severity: "medium" },
  { patterns: [/401/, /403/, /Unauthorized/i, /Forbidden/i, /AccessDeniedException/i, /AuthenticationException/i, /Invalid token/i, /token expired/i], title: "Authentication / Authorization Error (401/403)", rootCause: "The request lacks valid credentials or the token has expired.", fix: "Verify the auth token is present, valid, and not expired.", severity: "high" },
  { patterns: [/404/, /Not Found/i, /ResourceNotFoundException/i, /NoSuchKey/i], title: "Resource Not Found (404)", rootCause: "The requested resource, record, or endpoint does not exist.", fix: "Validate that the resource ID exists before the operation.", severity: "medium" },
  { patterns: [/500/, /Internal Server Error/i, /InternalError/i, /ServiceException/i], title: "Internal Server Error (500)", rootCause: "An unhandled exception occurred on the server side.", fix: "Look at the innermost exception in the stack trace.", severity: "critical" },
  { patterns: [/TimeoutException/i, /Read timed out/i, /Request timeout/i, /Gateway Timeout/i, /504/], title: "Request / Gateway Timeout", rootCause: "The operation exceeded its time limit.", fix: "Profile the slow operation. Consider increasing timeouts or optimizing the downstream call.", severity: "high" },
  { patterns: [/JsonParseException/i, /JsonMappingException/i, /SerializationException/i, /UnrecognizedPropertyException/i, /MismatchedInputException/i, /JSONException/i], title: "JSON / Serialization Error", rootCause: "Failed to parse or serialize JSON.", fix: "Log the raw input payload. Compare it against the expected model.", severity: "medium" },
  { patterns: [/PlatformTabComponentsUtil/i, /updateLayout/i, /constructJsonAndUpdateLayout/i, /LayoutForm/i, /createLayoutAction/i], title: "Layout / Component Update Failure", rootCause: "An error occurred while constructing or updating a CRM layout/component.", fix: "Check for invalid field references or circular layout dependencies.", severity: "high" },
  { patterns: [/modulecreate\.exception/i, /ModuleCreateException/i, /PublishException/i, /publish.*fail/i], title: "Module Create / Publish Exception", rootCause: "The module creation or publish pipeline threw an exception.", fix: "Review the full stack trace for the innermost cause.", severity: "critical" },
  { patterns: [/upgrading customer/i, /upgrade.*account/i, /UpgradeException/i], title: "Upgrade Flow Exception", rootCause: "The account upgrade process failed.", fix: "Check the ZOID's current plan state and verify the billing/payment service.", severity: "critical" },
  { patterns: [/SignupException/i, /signup.*fail/i, /account.*creat.*fail/i, /org.*creat.*fail/i], title: "Signup Flow Exception", rootCause: "Account or organisation creation failed during the signup flow.", fix: "Check if the ZOID/ZUID already exists. Look for duplicate key errors.", severity: "critical" },
  { patterns: [/InviteException/i, /invite.*fail/i, /invitation.*error/i], title: "Invite Flow Exception", rootCause: "Sending or processing an invite failed.", fix: "Validate the invitee's email and check if the user already belongs to the org.", severity: "high" },
  { patterns: [/ClassCastException/i], title: "Class Cast Exception", rootCause: "Code attempted to cast an object to an incompatible type at runtime.", fix: "Use `instanceof` checks before casting.", severity: "medium" },
  { patterns: [/IllegalArgumentException/i, /IllegalStateException/i], title: "Illegal Argument / State", rootCause: "A method received an argument it cannot handle, or the object was in an invalid state.", fix: "Add input validation before the failing method.", severity: "medium" },
  { patterns: [/IOException/i, /FileNotFoundException/i, /EOFException/i], title: "I/O Error", rootCause: "A file, stream, or I/O operation failed.", fix: "Verify the file path and permissions. Ensure streams are closed properly.", severity: "high" },
];

const SEVERITY_STYLE = {
  critical: { color: "#ff6b6b", label: "🔴 CRITICAL", bg: "rgba(255,107,107,0.1)" },
  high:     { color: "#f0883e", label: "🟠 HIGH",     bg: "rgba(240,136,62,0.1)"  },
  medium:   { color: "#FBBF24", label: "🟡 MEDIUM",   bg: "rgba(251,191,36,0.1)"  },
  low:      { color: "#3fb950", label: "🟢 LOW",      bg: "rgba(63,185,80,0.1)"   },
  info:     { color: "#58a6ff", label: "🔵 INFO",     bg: "rgba(88,166,255,0.1)"  },
};

const FLOW_COLOURS = {
  publish: { bg: "#f0883e", text: "#000" },
  signup:  { bg: "#3fb950", text: "#000" },
  invite:  { bg: "#58a6ff", text: "#000" },
  upgrade: { bg: "#d2a8ff", text: "#000" },
};

// ─── UTILS ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function formatTs(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }) + " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function flowTagStyle(flow) {
  const c = FLOW_COLOURS[(flow ?? "").toLowerCase()] ?? { bg: "#6e7681", text: "#fff" };
  return { background: c.bg, color: c.text, fontWeight: 700 };
}

function getDayBounds(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return {
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0),
    end:   new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999),
  };
}

function getCacheKey(moduleName, page) { return `${CACHE_KEY_PREFIX}${moduleName}_page_${page}`; }

function saveToCache(moduleName, page, data) {
  try { localStorage.setItem(getCacheKey(moduleName, page), JSON.stringify({ timestamp: Date.now(), data })); }
  catch (err) { console.warn("Cache save failed:", err); }
}

function getFromCache(moduleName, page) {
  try {
    const cached = localStorage.getItem(getCacheKey(moduleName, page));
    if (!cached) return null;
    const { timestamp, data } = JSON.parse(cached);
    if (Date.now() - timestamp > CACHE_EXPIRY_MS) { localStorage.removeItem(getCacheKey(moduleName, page)); return null; }
    return data;
  } catch { return null; }
}

function clearAllCache() {
  try { Object.keys(localStorage).filter(k => k.startsWith(CACHE_KEY_PREFIX)).forEach(k => localStorage.removeItem(k)); }
  catch (err) { console.warn("Cache clear failed:", err); }
}

// ─── DATA LAYER ──────────────────────────────────────────────────────────────
function normaliseFlowType(rec, sourceModule) {
  if (sourceModule === "signupfailure")  return "Signup";
  if (sourceModule === "Invitefailure")  return "Invite";
  if (sourceModule === "publishfailure") return "Publish";
  if (sourceModule === "upgradefailure") return "Upgrade";
  const raw = rec.Flow_Type ?? rec.flow_type ?? rec.FlowType ?? rec.flowtype ?? rec["Flow Type"] ?? null;
  if (!raw) return "Publish";
  const s = String(raw).trim().toLowerCase();
  if (s === "publish") return "Publish";
  if (s === "signup")  return "Signup";
  if (s === "invite")  return "Invite";
  if (s === "upgrade") return "Upgrade";
  return String(raw).trim();
}

function promoteCatalystFields(rec) {
  const pick = (...keys) => { for (const k of keys) { if (rec[k] !== undefined && rec[k] !== null && rec[k] !== "") return rec[k]; } return null; };
  return {
    id:           pick("id","ID","record_id","recordId"),
    Name:         pick("Name","name"),
    ZOID:         pick("ZOID","zoid","Zoid"),
    ZUID:         pick("ZUID","zuid","Zuid"),
    Created_Time: pick("Created_Time","created_time","CreatedTime","RequestTime","requesttime"),
    Request_Time: pick("Request_Time","RequestTime","request_time","requesttime","Created_Time"),
    ServerName:   pick("ServerName","server_name","servername","Server_Name"),
    threadid:     pick("threadid","thread_id","ThreadId","threadId"),
    requestid:    pick("requestid","request_id","RequestId","requestId"),
    Statuscode:   pick("Statuscode","status_code","statuscode","StatusCode","status"),
    BuildID:      pick("BuildID","build_id","buildid","BuildId"),
    Changeset:    pick("Changeset","changeset","change_set"),
    Exception_trace:          pick("Exception_trace","exception_trace","ExceptionTrace","stacktrace","stack_trace"),
    Error_message:            pick("Error_message","error_message","ErrorMessage","errormessage"),
    Reason_for_the_exception: pick("Reason_for_the_exception","reason_for_the_exception","ReasonForException","reason","failure_reason"),
    Flow_Type:    pick("Flow_Type","flow_type","FlowType","flowtype","Flow Type"),
  };
}

function normaliseRecord(rec, sourceModule) {
  return {
    id:                       rec.id ?? rec.ID ?? null,
    Name:                     rec.Name ?? rec.name ?? "Unknown",
    ZOID:                     rec.ZOID != null ? String(rec.ZOID) : "unknown",
    ZUID:                     rec.ZUID ?? rec.zuid ?? null,
    threadid:                 rec.threadid ?? null,
    Statuscode:               rec.Statuscode ?? null,
    ServerName:               rec.ServerName ?? null,
    requestid:                rec.requestid ?? null,
    Changeset:                rec.Changeset ?? null,
    BuildID:                  rec.BuildID ?? null,
    Flow_Type:                normaliseFlowType(rec, sourceModule),
    Created_Time:             rec.Created_Time ?? null,
    Request_Time:             rec.Request_Time ?? rec.Created_Time ?? null,
    Source_Module:            sourceModule,
    Exception_trace:          rec.Exception_trace ?? null,
    Error_message:            rec.Error_message ?? null,
    Reason_for_the_exception: rec.Reason_for_the_exception ?? null,
  };
}

function parseCatalystResponse(raw) {
  try {
    let l1 = raw; if (typeof l1 === "string") l1 = JSON.parse(l1);
    let l2 = l1?.output ?? l1; if (typeof l2 === "string") l2 = JSON.parse(l2);
    let l3 = l2?.details?.output ?? l2?.data ?? l2; if (typeof l3 === "string") l3 = JSON.parse(l3);
    if (Array.isArray(l3)) return { data: l3, hasMore: false };
    return { data: Array.isArray(l3?.data) ? l3.data : [], hasMore: l3?.info?.more_records === true || l3?.info?.more_records === "true" };
  } catch { return { data: [], hasMore: false }; }
}

async function fetchPageFromModule(moduleName, page = 1) {
  const cached = getFromCache(moduleName, page);
  if (cached) return cached;
  try {
    const url = `${CATALYST_API_BASE}?module=${encodeURIComponent(moduleName)}&page=${page}&per_page=${PAGE_SIZE}`;
    const response = await axios.get(url);
    const rawJson = response.data;
    const { data, hasMore } = parseCatalystResponse(rawJson);
    const records = data.map(rec => normaliseRecord(promoteCatalystFields(rec), moduleName));
    const result = { records, hasMore };
    saveToCache(moduleName, page, result);
    return result;
  } catch (err) {
    console.error(`Catalyst fetch failed [${moduleName} p${page}]:`, err);
    return { records: [], hasMore: false };
  }
}

async function fetchPage(page = 1) {
  const [pub, sig, inv, upg] = await Promise.all([
    fetchPageFromModule("publishfailure", page),
    fetchPageFromModule("signupfailure",  page),
    fetchPageFromModule("Invitefailure",  page),
    fetchPageFromModule("upgradefailure", page),
  ]);
  const combined = [...pub.records, ...sig.records, ...inv.records, ...upg.records];
  combined.sort((a, b) => new Date(b.Request_Time ?? b.Created_Time) - new Date(a.Request_Time ?? a.Created_Time));
  return { records: combined, hasMore: pub.hasMore || sig.hasMore || inv.hasMore || upg.hasMore };
}

async function fetchAllRecords() {
  let all = [], page = 1, more = true;
  while (more && page <= 10) {
    const { records, hasMore: m } = await fetchPage(page);
    all.push(...records); more = m; page++;
  }
  return all;
}

// ─── HIERARCHY ───────────────────────────────────────────────────────────────
function buildHierarchy(records) {
  const map = new Map();
  for (const rec of records) {
    const { Name: name, ZOID: zoid, Flow_Type: flow } = rec;
    const orgKey = rec.ZUID ?? "unknown";
    if (!map.has(name)) map.set(name, { zoidMap: new Map(), sample: rec });
    const { zoidMap } = map.get(name);
    if (!zoidMap.has(zoid)) zoidMap.set(zoid, { flowMap: new Map(), sample: rec });
    const { flowMap } = zoidMap.get(zoid);
    if (!flowMap.has(flow)) flowMap.set(flow, new Map());
    const orgMap = flowMap.get(flow);
    if (!orgMap.has(orgKey)) orgMap.set(orgKey, []);
    orgMap.get(orgKey).push(rec);
  }
  const byLatest = (a, b) => new Date(b.latest) - new Date(a.latest);
  return [...map.entries()].map(([name, { zoidMap, sample }]) => {
    const zoids = [...zoidMap.entries()].map(([zoid, { flowMap, sample: zs }]) => {
      const flows = [...flowMap.entries()].map(([flow, orgMap]) => {
        const orgs = [...orgMap.entries()].map(([orgKey, recs]) => {
          const sorted = [...recs].sort((a, b) => new Date(b.Request_Time ?? b.Created_Time) - new Date(a.Request_Time ?? a.Created_Time));
          return { orgKey, records: sorted, count: sorted.length, latest: sorted[0]?.Request_Time ?? sorted[0]?.Created_Time };
        }).sort(byLatest);
        return { flow, orgs, count: orgs.reduce((s, o) => s + o.count, 0), latest: orgs[0]?.latest };
      }).sort(byLatest);
      return { zoid, sample: zs, flows, count: flows.reduce((s, f) => s + f.count, 0), latest: flows[0]?.latest };
    }).sort(byLatest);
    return { name, sample, zoids, count: zoids.reduce((s, z) => s + z.count, 0), latest: zoids[0]?.latest };
  }).sort(byLatest);
}

// ─── LOGS URL ─────────────────────────────────────────────────────────────────
function getLogsConfig(flowType) {
  const flow = (flowType ?? "").toLowerCase();
  if (flow === "invite")  return { className: "PartnerActions",     methodName: "inviteOrgSignup",     dateQuery: "Last%204%20weeks", timestamp: "1771530113146", extraFilter: "" };
  if (flow === "publish") return { className: "PartnerActions",     methodName: "publishApp",          dateQuery: "Last%204%20weeks", timestamp: "1771530113146", extraFilter: "" };
  if (flow === "signup")  return { className: "PlatformSignupUtil", methodName: "createOrgInstanceNew", dateQuery: "Last%203%20weeks", timestamp: "1771528805147", extraFilter: "%20and%20message%20contains%20%22error%20in%20create%20org%22" };
  return null;
}

function buildLogsUrl(rec) {
  const config = getLogsConfig(rec.Flow_Type);
  if (!config) return null;
  const threadId  = encodeURIComponent(rec.threadid  ?? "");
  const requestId = encodeURIComponent(rec.requestid ?? "");
  const q = "logtype%3D%22application%22" +
    "%20and%20thread_id%20%3D%20%22" + threadId + "%22" +
    "%20and%20req_id%20contains%20%22" + requestId + "%22" +
    "%20and%20class_name%20contains%20%22" + encodeURIComponent(config.className) + "%22" +
    "%20and%20method%20contains%20%22" + encodeURIComponent(config.methodName) + "%22" +
    config.extraFilter;
  return "https://logs.zoho.com/app.zl#/project/zoho/service/Platform/search/normal?searchQuery=" + q +
    "&dateQuery=" + config.dateQuery + "&timeZone=America%2FLos_Angeles&order=desc&timestamp=" + config.timestamp + "&page=1&itemsPerPage=100";
}

// ─── EXCEPTION ANALYZER ──────────────────────────────────────────────────────
function analyzeException(rec) {
  const corpus = [rec.Exception_trace ?? "", rec.Error_message ?? "", rec.Reason_for_the_exception ?? ""].join("\n");
  return { corpus, matches: EXCEPTION_PATTERNS.filter(r => r.patterns.some(p => p.test(corpus))) };
}

function extractStackFrames(trace, max = 8) {
  if (!trace) return [];
  return trace.split("\n").map(l => l.trim()).filter(l => l.startsWith("at ") || l.match(/^\w.*\(.*\.java:\d+\)/)).slice(0, max);
}

function extractClasses(trace) {
  if (!trace) return [];
  const hits = new Set();
  for (const m of (trace.matchAll(/at ([\w$.]+)\./g) ?? [])) { const parts = m[1].split("."); if (parts.length) hits.add(parts[parts.length - 1]); }
  return [...hits].slice(0, 6);
}

function buildAnalysisHTML(rec, userQuestion) {
  const { matches } = analyzeException(rec);
  const wantsRootCause = /root.?cause|why|what.*caus|reason/i.test(userQuestion);
  const wantsFix       = /fix|solve|resolv|solution|how to|suggest/i.test(userQuestion);
  const wantsTrace     = /trace|stack|step|explain|walk.*through|frame/i.test(userQuestion);
  const wantsKnown     = /known|bug|pattern|similar|common/i.test(userQuestion);
  const showAll        = !wantsRootCause && !wantsFix && !wantsTrace && !wantsKnown;

  const sev   = matches[0]?.severity ?? "info";
  const style = SEVERITY_STYLE[sev] ?? SEVERITY_STYLE.info;
  let html = `<div style="background:${style.bg};border:1px solid ${style.color};border-radius:6px;padding:8px 10px;margin-bottom:10px"><span style="font-weight:700;color:${style.color}">${style.label}</span> · <span style="color:#ccc;font-size:10px">${rec.Flow_Type ?? ""} · HTTP ${rec.Statuscode ?? "–"} · ${rec.ServerName ?? "–"}</span></div>`;

  if (!matches.length) {
    html += `<div style="color:#a0a0a0;font-size:11px">No known exception pattern matched.</div><br>`;
    if (rec.Error_message)   html += `<strong>Error Message:</strong><br><pre>${escHtml(rec.Error_message.slice(0, 600))}</pre>`;
    if (rec.Exception_trace) html += `<strong>Top Stack Frames:</strong><br><pre>${escHtml(extractStackFrames(rec.Exception_trace).join("\n"))}</pre>`;
    return html;
  }

  matches.forEach((match, idx) => {
    if (idx > 0) html += `<hr style="border-color:rgba(255,255,255,0.08);margin:10px 0">`;
    const ms = SEVERITY_STYLE[match.severity] ?? SEVERITY_STYLE.info;
    html += `<div style="font-size:11px;font-weight:700;color:${ms.color};margin-bottom:6px">${idx === 0 ? "🎯" : "🔎"} ${escHtml(match.title)}</div>`;
    if (wantsRootCause || showAll) html += `<div style="margin-bottom:6px"><span style="color:#FBBF24;font-weight:700;font-size:10px">ROOT CAUSE</span><br><span style="color:#e0d0b0">${escHtml(match.rootCause)}</span></div>`;
    if (wantsFix       || showAll) html += `<div style="margin-bottom:6px"><span style="color:#3fb950;font-weight:700;font-size:10px">SUGGESTED FIX</span><br><span style="color:#b0e0b8">${escHtml(match.fix)}</span></div>`;
    if (wantsKnown     || showAll) html += `<div style="margin-bottom:4px"><span style="color:#58a6ff;font-weight:700;font-size:10px">PATTERN</span> <code style="font-size:9px">${escHtml(match.patterns.map(p => p.toString().replace(/\/[gi]*$/, "").replace(/^\//, "")).join(" | "))}</code></div>`;
  });

  if ((wantsTrace || showAll) && rec.Exception_trace) {
    const frames = extractStackFrames(rec.Exception_trace);
    const classes = extractClasses(rec.Exception_trace);
    html += `<hr style="border-color:rgba(255,255,255,0.08);margin:10px 0"><div style="color:#FBBF24;font-weight:700;font-size:10px;margin-bottom:4px">📋 TOP STACK FRAMES</div><pre style="font-size:9.5px;line-height:1.6">${escHtml(frames.join("\n") || "No parseable frames found.")}</pre>`;
    if (classes.length) html += `<div style="color:#58a6ff;font-size:10px;margin-top:4px"><strong>Classes involved:</strong> ${classes.map(c => `<code>${escHtml(c)}</code>`).join(" · ")}</div>`;
  }

  if (showAll) html += `<hr style="border-color:rgba(255,255,255,0.08);margin:10px 0"><div style="color:#888;font-size:9.5px;line-height:1.8"><strong style="color:#aaa">Record:</strong> ${escHtml(rec.Name ?? "–")}  <strong style="color:#aaa">ZOID:</strong> ${escHtml(rec.ZOID ?? "–")}  <strong style="color:#aaa">Build:</strong> ${escHtml(rec.BuildID ?? "–")}  <strong style="color:#aaa">Changeset:</strong> ${escHtml(rec.Changeset ?? "–")}  <strong style="color:#aaa">Thread:</strong> ${escHtml(rec.threadid ?? "–")}</div>`;
  return html;
}

// ─── SUB-COMPONENTS ──────────────────────────────────────────────────────────

function FlowTag({ flow }) {
  const s = flowTagStyle(flow);
  return (
    <span style={{ ...s, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", fontWeight: 700 }}>
      {flow}
    </span>
  );
}

function CountBadge({ count, red }) {
  return (
    <span style={{
      background: red ? "rgba(240,82,82,0.1)" : "var(--surface2)",
      border: `1px solid ${red ? "rgba(240,82,82,0.3)" : "var(--border)"}`,
      color: red ? "var(--red)" : "var(--text2)",
      borderRadius: 10, fontFamily: "var(--mono)", fontSize: 10, padding: "2px 8px",
    }}>
      {count}
    </span>
  );
}

function RecordCard({ rec, onOpenException, onFetchTrace }) {
  const [idRevealed, setIdRevealed] = useState(false);
  const hasExc  = !!(rec.Exception_trace || rec.Error_message || rec.Reason_for_the_exception);
  const hasTrace = !!rec.Exception_trace;

  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, background: "var(--red)", opacity: 0.6 }} />
      {[
        { k: "Request Time", v: formatTs(rec.Request_Time ?? rec.Created_Time), style: { color: "#2dc97e" } },
        { k: "Status Code",  v: rec.Statuscode ?? "–", style: { color: "var(--yellow)", background: "rgba(245,166,35,0.08)", borderRadius: 3, padding: "1px 5px", display: "inline-block" } },
        { k: "Server",       v: rec.ServerName  ?? "–" },
        { k: "Thread ID",    v: rec.threadid    ?? "–" },
        { k: "Request ID",   v: rec.requestid   ?? "–" },
        { k: "Changeset",    v: rec.Changeset   ?? "–" },
        { k: "Build ID",     v: rec.BuildID     ?? "–" },
        { k: "Source",       v: rec.Source_Module ?? "–", style: { fontSize: 10, opacity: 0.7 } },
      ].map(({ k, v, style }) => (
        <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.08em", color: "var(--text3)", textTransform: "uppercase" }}>{k}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(style ?? {}) }}>{v}</span>
        </div>
      ))}

      {rec.id && (
        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 6, marginTop: 6, paddingTop: 6, borderTop: "1px dashed #1e1e1e" }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.6px", opacity: 0.6 }}>Record ID</span>
          <span
            onClick={() => setIdRevealed(v => !v)}
            style={{ fontSize: 9, fontFamily: "var(--mono)", color: "#6e7681", filter: idRevealed ? "none" : "blur(3.5px)", cursor: "pointer", transition: "filter 0.2s" }}
          >{rec.id}</span>
          <span style={{ fontSize: 10, cursor: "pointer", opacity: 0.35 }} onClick={() => setIdRevealed(v => !v)}>👁</span>
        </div>
      )}

      {(hasExc || !hasTrace) && (
        <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {hasExc && (
            <button onClick={() => onOpenException(rec)} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: "#ff6b6b", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.35)", borderRadius: 4, padding: "3px 8px", cursor: "pointer", letterSpacing: "0.4px", textTransform: "uppercase" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ff6b6b", display: "inline-block", animation: "excPulse 1.8s infinite" }} />
              ⚠ Exception Details
            </button>
          )}
          {!hasTrace && (
            <GetTraceButton rec={rec} onFetch={onFetchTrace} />
          )}
        </div>
      )}
    </div>
  );
}

function GetTraceButton({ rec, onFetch }) {
  const [loading, setLoading] = useState(false);
  const handleClick = async () => {
    setLoading(true);
    await onFetch(rec);
    setLoading(false);
  };
  return (
    <button onClick={handleClick} disabled={loading} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: "#58a6ff", background: "rgba(88,166,255,0.07)", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 4, padding: "3px 8px", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.5 : 1, textTransform: "uppercase", letterSpacing: "0.4px" }}>
      {loading ? (
        <span style={{ width: 8, height: 8, border: "1.5px solid rgba(88,166,255,0.3)", borderTopColor: "#58a6ff", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
      ) : "⇣"}
      <span>{loading ? "Fetching…" : "Get Exception Trace"}</span>
    </button>
  );
}

function OrgNode({ orgNode, allExpanded, onOpenException, onFetchTrace }) {
  const [open, setOpen] = useState(allExpanded);
  useEffect(() => setOpen(allExpanded), [allExpanded]);
  return (
    <div style={{ background: "var(--surface3)", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
      <div onClick={() => setOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--text3)", fontSize: 11, transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ color: "var(--text3)", fontSize: 10 }}>ZUID </span>{orgNode.orgKey}
        </span>
        <CountBadge count={orgNode.count} />
      </div>
      {open && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          {orgNode.records.map((rec, i) => (
            <RecordCard key={i} rec={rec} onOpenException={onOpenException} onFetchTrace={onFetchTrace} />
          ))}
        </div>
      )}
    </div>
  );
}

function FlowNode({ flowNode, allExpanded, onOpenException, onFetchTrace }) {
  const [open, setOpen] = useState(allExpanded);
  useEffect(() => setOpen(allExpanded), [allExpanded]);
  return (
    <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div onClick={() => setOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--text3)", fontSize: 11, transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <FlowTag flow={flowNode.flow} />
        <span style={{ fontSize: 12, color: "var(--text2)", flex: 1 }}>{flowNode.count} failure{flowNode.count !== 1 ? "s" : ""} across {flowNode.orgs.length} user{flowNode.orgs.length !== 1 ? "s" : ""}</span>
        <CountBadge count={flowNode.count} />
      </div>
      {open && (
        <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
          {flowNode.orgs.map((org, i) => (
            <OrgNode key={i} orgNode={org} allExpanded={allExpanded} onOpenException={onOpenException} onFetchTrace={onFetchTrace} />
          ))}
        </div>
      )}
    </div>
  );
}

function ZoidNode({ zoidNode, allExpanded, onOpenException, onFetchTrace }) {
  const [open, setOpen] = useState(allExpanded);
  useEffect(() => setOpen(allExpanded), [allExpanded]);
  const s = zoidNode.sample;
  return (
    <div style={{ margin: "0 0 8px 0", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg2, #10131a)" }}>
      <div onClick={() => setOpen(v => !v)} style={{ padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--text2)", fontSize: 11, transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--mono)" }}>ZOID: {zoidNode.zoid}</span>
        <CountBadge count={zoidNode.count} />
      </div>
      {open && (
        <div>
          <div style={{ padding: "7px 14px 9px", display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 11, color: "var(--text2)", borderBottom: "1px solid var(--border)" }}>
            {[["Server", s.ServerName], ["Build", s.BuildID], ["Changeset", s.Changeset], ["Status", s.Statuscode], ["Thread", s.threadid], ["Request", s.requestid]].map(([label, val]) => (
              <span key={label}><span style={{ color: "var(--text3)" }}>{label}</span> {val ?? "–"}</span>
            ))}
          </div>
          <div style={{ padding: "7px 14px 9px", display: "flex", flexDirection: "column", gap: 6 }}>
            {zoidNode.flows.map((flow, i) => (
              <FlowNode key={i} flowNode={flow} allExpanded={allExpanded} onOpenException={onOpenException} onFetchTrace={onFetchTrace} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DomainNode({ nameNode, allExpanded, onOpenException, onFetchTrace }) {
  const [open, setOpen] = useState(allExpanded);
  useEffect(() => setOpen(allExpanded), [allExpanded]);
  const flowCounts = {};
  nameNode.zoids.forEach(z => z.flows.forEach(f => { flowCounts[f.flow] = (flowCounts[f.flow] || 0) + f.count; }));
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      <div onClick={() => setOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--text3)", fontSize: 11, transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500, flex: 1 }}>{nameNode.name}</span>
        <CountBadge count={`${nameNode.count} failure${nameNode.count !== 1 ? "s" : ""}`} red />
        {Object.entries(flowCounts).sort((a,b) => b[1]-a[1]).map(([flow, count]) => (
          <span key={flow} style={{ ...flowTagStyle(flow), fontFamily: "var(--mono)", fontSize: 11, padding: "3px 8px", borderRadius: 4, marginLeft: 6, fontWeight: 700 }}>
            {flow}: {count}
          </span>
        ))}
      </div>
      {open && (
        <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          {nameNode.zoids.map((z, i) => (
            <ZoidNode key={i} zoidNode={z} allExpanded={allExpanded} onOpenException={onOpenException} onFetchTrace={onFetchTrace} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── EXCEPTION MODAL ─────────────────────────────────────────────────────────
function ExceptionModal({ rec, onClose, onAnalyze }) {
  const logsUrl = rec ? buildLogsUrl(rec) : null;
  const fields = rec ? [
    { label: "Error Message",        value: rec.Error_message            },
    { label: "Reason for Exception", value: rec.Reason_for_the_exception },
    { label: "Exception Trace",      value: rec.Exception_trace          },
  ].filter(f => f.value) : [];

  const subtitle = rec ? [rec.Name ?? "", rec.ZOID ? `ZOID: ${rec.ZOID}` : "", formatTs(rec.Request_Time ?? rec.Created_Time)].filter(Boolean).join("  ·  ") : "";

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#140a0a", border: "1px solid #5a2020", borderRadius: 10, width: "100%", maxWidth: 700, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,0.7)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "#1e0b0b", borderBottom: "1px solid #3d1f1f", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 22, filter: "drop-shadow(0 0 8px rgba(255,107,107,0.5))" }}>⚠</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#ff6b6b", letterSpacing: "0.5px", textTransform: "uppercase" }}>Exception Details</div>
              <div style={{ fontSize: 11, color: "#a06060", marginTop: 2, fontFamily: "monospace" }}>{subtitle}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "1px solid #3d1f1f", color: "#a06060", fontSize: 13, width: 28, height: 28, borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          {fields.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: "40px 20px", color: "#6e7681" }}>
              <div style={{ fontSize: 22 }}>⊘</div>
              <div style={{ fontSize: 12, fontFamily: "monospace" }}>No exception details found on this record.</div>
            </div>
          ) : fields.map(f => (
            <div key={f.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#ff9999", textTransform: "uppercase", letterSpacing: "0.8px", display: "flex", alignItems: "center", gap: 6 }}>
                {f.label}
                <span style={{ flex: 1, height: 1, background: "linear-gradient(to right, #3d1f1f, transparent)" }} />
              </div>
              <div style={{ fontSize: 11, color: "#ffcccc", fontFamily: "monospace", lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-all", background: "#0d0505", border: "1px solid #3d1f1f", borderRadius: 4, padding: "6px 8px", maxHeight: 180, overflowY: "auto" }}>
                {f.value}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #3d1f1f", background: "#1e0b0b", display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0 }}>
          {fields.length > 0 && (
            <button onClick={() => onAnalyze(rec)} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 700, color: "#D97706", background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.35)", borderRadius: 5, padding: "6px 14px", cursor: "pointer", letterSpacing: "0.4px", textTransform: "uppercase", marginRight: "auto" }}>
              ✦ Analyze Exception
            </button>
          )}
          {logsUrl && (
            <button onClick={() => window.open(logsUrl, "_blank", "noopener,noreferrer")} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "#58a6ff", background: "rgba(88,166,255,0.08)", border: "1px solid rgba(88,166,255,0.35)", borderRadius: 5, padding: "6px 14px", cursor: "pointer", letterSpacing: "0.4px", textTransform: "uppercase" }}>
              📋 View Logs ↗
            </button>
          )}
          <button onClick={onClose} style={{ background: "#2a1212", border: "1px solid #5a2020", color: "#ff8080", fontSize: 12, fontWeight: 600, padding: "6px 18px", borderRadius: 5, cursor: "pointer" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── CHAT WINDOW ─────────────────────────────────────────────────────────────
function ChatWindow({ contextRec, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef(null);
  const pos = useRef({ x: window.innerWidth - 460, y: 80 });
  const [position, setPosition] = useState({ x: window.innerWidth - 460, y: 80 });
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const onMouseDown = (e) => {
    dragging.current = true;
    offset.current = { x: e.clientX - pos.current.x, y: e.clientY - pos.current.y };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 420, e.clientX - offset.current.x));
      const ny = Math.max(0, Math.min(window.innerHeight - 400, e.clientY - offset.current.y));
      pos.current = { x: nx, y: ny };
      setPosition({ x: nx, y: ny });
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  const QUICK_PROMPTS = [
    { label: "🔍 Root cause",  text: "Analyze this exception and identify the root cause" },
    { label: "🔧 Suggest fix", text: "What is the most likely fix for this error?" },
    { label: "📖 Explain trace", text: "Explain this stack trace step by step" },
    { label: "🐛 Known issues",  text: "Is this a known bug pattern? What similar issues exist?" },
  ];

  const sendMessage = async (text) => {
    if (streaming || !text.trim()) return;
    setInput("");
    setStreaming(true);
    setMessages(prev => [...prev, { role: "user", content: text }]);
    await new Promise(r => setTimeout(r, 420));
    let reply;
    if (!contextRec) {
      reply = { role: "ai", content: "⚠ No exception record loaded. Open an exception modal and click <strong>Analyze Exception</strong> first.", error: true };
    } else {
      reply = { role: "ai", content: buildAnalysisHTML(contextRec, text), isHtml: true };
    }
    setMessages(prev => [...prev, reply]);
    setStreaming(false);
  };

  const msgCount = messages.length;

  return (
    <div style={{ position: "fixed", top: position.y, left: position.x, width: 420, maxHeight: "80vh", minHeight: 360, background: "#0d0a05", border: "1px solid rgba(217,119,6,0.28)", borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", zIndex: 10001, overflow: "hidden" }}>
      {/* Header */}
      <div onMouseDown={onMouseDown} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: "linear-gradient(135deg,#0d0900,#1a1000)", borderBottom: "1px solid rgba(217,119,6,0.18)", cursor: "move", flexShrink: 0, userSelect: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(217,119,6,0.12)", border: "1px solid rgba(217,119,6,0.25)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z" fill="url(#cg)" /><defs><linearGradient id="cg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#D97706"/><stop offset="50%" stopColor="#F59E0B"/><stop offset="100%" stopColor="#FBBF24"/></linearGradient></defs></svg>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#FBBF24", letterSpacing: "0.3px" }}>Exception Analyzer</div>
            <div style={{ fontSize: 10, color: "#78500c", fontFamily: "monospace", marginTop: 1, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {contextRec ? `${contextRec.Name ?? "Exception"} · ${contextRec.Flow_Type ?? ""} — local analysis` : "Instant local analysis — no API needed"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#a06010", background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.22)", borderRadius: 4, padding: "2px 6px", letterSpacing: "0.4px", fontFamily: "monospace" }}>local engine</span>
          <button onClick={() => setMessages([])} title="Clear" style={{ background: "none", border: "1px solid rgba(217,119,6,0.2)", color: "#78500c", fontSize: 11, width: 24, height: 24, borderRadius: 5, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>⌫</button>
          <button onClick={onClose} style={{ background: "none", border: "1px solid rgba(217,119,6,0.2)", color: "#78500c", fontSize: 11, width: 24, height: 24, borderRadius: 5, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>
      </div>

      {/* Context bar */}
      {contextRec && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 14px", background: "rgba(217,119,6,0.05)", borderBottom: "1px solid rgba(217,119,6,0.1)", flexShrink: 0 }}>
          <span style={{ fontSize: 11 }}>📋</span>
          <span style={{ fontSize: 10, color: "#a06010", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[contextRec.Name, contextRec.ZOID ? `ZOID: ${contextRec.ZOID}` : null, contextRec.Flow_Type, contextRec.Statuscode ? `HTTP ${contextRec.Statuscode}` : null].filter(Boolean).join("  ·  ")}
          </span>
          <span style={{ fontSize: 8, fontWeight: 700, color: "#3fb950", background: "rgba(63,185,80,0.1)", border: "1px solid rgba(63,185,80,0.25)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.5px" }}>Context Loaded</span>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
        {messages.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "30px 20px", textAlign: "center", flex: 1 }}>
            <div style={{ fontSize: 28, background: "linear-gradient(135deg,#D97706,#FBBF24)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>✦</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#FBBF24" }}>Exception Analyzer ready</div>
            <div style={{ fontSize: 11, color: "#78500c", lineHeight: 1.6, maxWidth: 300 }}>Select an exception record and click <strong style={{ color: "#a06010" }}>Analyze Exception</strong> to analyze the trace.</div>
          </div>
        ) : messages.map((msg, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.6px", textTransform: "uppercase", opacity: 0.5, color: msg.role === "user" ? "#D97706" : "#FBBF24", padding: "0 4px" }}>{msg.role === "user" ? "You" : "Claude"}</div>
            <div style={{ maxWidth: "88%", padding: "9px 12px", borderRadius: msg.role === "user" ? "10px 10px 2px 10px" : "2px 10px 10px 10px", fontSize: 11.5, lineHeight: 1.6, wordBreak: "break-word", background: msg.error ? "rgba(255,107,107,0.08)" : msg.role === "user" ? "rgba(217,119,6,0.12)" : "rgba(217,119,6,0.06)", border: `1px solid ${msg.error ? "rgba(255,107,107,0.28)" : msg.role === "user" ? "rgba(217,119,6,0.28)" : "rgba(217,119,6,0.15)"}`, color: msg.error ? "#ff9999" : msg.role === "user" ? "#fde68a" : "#e8d5b0", fontFamily: msg.role === "ai" ? "monospace" : "inherit" }}>
              {msg.isHtml ? <span dangerouslySetInnerHTML={{ __html: msg.content }} /> : msg.content}
            </div>
          </div>
        ))}
        {streaming && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.6px", textTransform: "uppercase", opacity: 0.5, color: "#FBBF24", padding: "0 4px" }}>Claude</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 12px", background: "rgba(217,119,6,0.06)", border: "1px solid rgba(217,119,6,0.15)", borderRadius: "2px 10px 10px 10px", width: "fit-content" }}>
              {[0, 0.2, 0.4].map((delay, j) => (
                <span key={j} style={{ width: 5, height: 5, borderRadius: "50%", background: "#D97706", opacity: 0.5, display: "inline-block", animation: `typingBounce 1.2s ${delay}s ease-in-out infinite` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick chips */}
      {messages.length === 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "6px 14px 4px", borderTop: "1px solid rgba(217,119,6,0.1)", flexShrink: 0 }}>
          {QUICK_PROMPTS.map(({ label, text }) => (
            <button key={label} onClick={() => sendMessage(text)} style={{ fontSize: 10, fontWeight: 600, color: "#a06010", background: "rgba(217,119,6,0.07)", border: "1px solid rgba(217,119,6,0.2)", borderRadius: 20, padding: "3px 10px", cursor: "pointer", whiteSpace: "nowrap", letterSpacing: "0.2px" }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ padding: "8px 12px 10px", borderTop: "1px solid rgba(217,119,6,0.15)", background: "rgba(0,0,0,0.25)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
            placeholder="Ask about this exception…"
            rows={1}
            disabled={streaming}
            style={{ flex: 1, background: "rgba(217,119,6,0.05)", border: "1px solid rgba(217,119,6,0.2)", borderRadius: 8, color: "#fde68a", fontSize: 12, fontFamily: "inherit", padding: "8px 10px", resize: "none", outline: "none", lineHeight: 1.5, maxHeight: 100, overflowY: "auto" }}
          />
          <button onClick={() => sendMessage(input)} disabled={streaming || !input.trim()} style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg,#D97706,#B45309)", border: "none", color: "#fff", fontSize: 13, cursor: streaming ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, opacity: (streaming || !input.trim()) ? 0.5 : 1, boxShadow: "0 2px 12px rgba(217,119,6,0.35)" }}>
            {streaming ? <span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.25)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} /> : "➤"}
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 5, padding: "0 2px" }}>
          <span style={{ fontSize: 9, color: "#3a1e04", fontFamily: "monospace" }}>{msgCount} message{msgCount !== 1 ? "s" : ""}</span>
          <span style={{ fontSize: 9, color: "#3a1e04", letterSpacing: "0.2px" }}>100% local · No API · No cost · Instant</span>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function FailureLogs() {
  const [rawRecords, setRawRecords] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [allExpanded, setAllExpanded] = useState(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [flowFilters, setFlowFilters] = useState({ Publish: true, Signup: true, Invite: true, Upgrade: true });
  const [dateFrom, setDateFrom]       = useState("");
  const [dateTo, setDateTo]           = useState("");
  const [errCode, setErrCode]         = useState("");
  const [quickView, setQuickView]     = useState("all");

  // Modal / chat
  const [modalRec, setModalRec]   = useState(null);
  const [chatOpen, setChatOpen]   = useState(false);
  const [chatRec, setChatRec]     = useState(null);

  const loadData = useCallback(async (clearCache = false) => {
    if (clearCache) clearAllCache();
    setLoading(true);
    const records = await fetchAllRecords();
    setRawRecords(records);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") { setModalRec(null); setChatOpen(false); } };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Quick view counts
  const quickCounts = useMemo(() => {
    const tb = getDayBounds(0), yb = getDayBounds(1);
    return {
      all:          rawRecords.length,
      "with-trace": rawRecords.filter(r => !!r.Exception_trace).length,
      "no-trace":   rawRecords.filter(r => !r.Exception_trace).length,
      today:        rawRecords.filter(r => { const t = new Date(r.Request_Time ?? r.Created_Time); return t >= tb.start && t <= tb.end; }).length,
      yesterday:    rawRecords.filter(r => { const t = new Date(r.Request_Time ?? r.Created_Time); return t >= yb.start && t <= yb.end; }).length,
    };
  }, [rawRecords]);

  // Filtered tree
  const tree = useMemo(() => {
    const tb = getDayBounds(0), yb = getDayBounds(1);
    const filtered = rawRecords.filter(rec => {
      if (quickView === "with-trace" && !rec.Exception_trace) return false;
      if (quickView === "no-trace"   &&  rec.Exception_trace) return false;
      if (quickView === "today") { const t = new Date(rec.Request_Time ?? rec.Created_Time); if (t < tb.start || t > tb.end) return false; }
      if (quickView === "yesterday") { const t = new Date(rec.Request_Time ?? rec.Created_Time); if (t < yb.start || t > yb.end) return false; }
      if (!flowFilters[(rec.Flow_Type ?? "")]) return false;
      const ts = new Date(rec.Request_Time ?? rec.Created_Time);
      if (dateFrom && ts < new Date(dateFrom + "T00:00:00Z")) return false;
      if (dateTo   && ts > new Date(dateTo   + "T23:59:59Z")) return false;
      if (errCode && !String(rec.Statuscode ?? "").toLowerCase().includes(errCode.toLowerCase())) return false;
      if (searchQuery) {
        const searchable = [rec.Name, rec.ZOID, rec.ZUID, rec.ServerName, rec.threadid, rec.requestid].filter(Boolean).map(v => String(v).toLowerCase());
        if (!searchable.some(v => v.includes(searchQuery.toLowerCase()))) return false;
      }
      return true;
    });
    return buildHierarchy(filtered);
  }, [rawRecords, searchQuery, flowFilters, dateFrom, dateTo, errCode, quickView]);

  const totalVisible = tree.reduce((s, d) => s + d.count, 0);

  const handleFetchTrace = useCallback(async (rec) => {
    setModalRec({ ...rec });
    // In a real environment with ZOHO SDK available:
    // await executeFunctionAndFetchRecord(rec);
    // setModalRec({ ...rec });
  }, []);

  const resetFilters = () => {
    setSearchQuery(""); setDateFrom(""); setDateTo(""); setErrCode("");
    setFlowFilters({ Publish: true, Signup: true, Invite: true, Upgrade: true });
    setQuickView("all");
  };

  const QUICK_VIEWS = [
    { key: "all", label: "All", activeColor: "#6e7681", activeBg: "rgba(110,118,129,0.08)", activeBorder: "rgba(110,118,129,0.35)" },
    { key: "with-trace", label: "With Trace", activeColor: "#3fb950", activeBg: "rgba(63,185,80,0.08)", activeBorder: "rgba(63,185,80,0.35)" },
    { key: "no-trace", label: "No Trace", activeColor: "#ff6b6b", activeBg: "rgba(255,107,107,0.08)", activeBorder: "rgba(255,107,107,0.35)" },
    { key: "today", label: "Today", activeColor: "#58a6ff", activeBg: "rgba(88,166,255,0.08)", activeBorder: "rgba(88,166,255,0.35)" },
    { key: "yesterday", label: "Yesterday", activeColor: "#d2a8ff", activeBg: "rgba(210,168,255,0.08)", activeBorder: "rgba(210,168,255,0.35)" },
  ];

  return (
    <>
      <style>{`
        :root {
          --bg: #0a0c10; --surface: #111318; --surface2: #181c24; --surface3: #1e2330;
          --border: #262d3d; --border2: #2e3750;
          --accent: #4f8ef7; --accent2: #7c5cfc;
          --red: #f05252; --yellow: #f5a623; --green: #27c47f;
          --text: #e2e8f7; --text2: #8b96b0; --text3: #5a6380;
          --mono: 'IBM Plex Mono', monospace; --sans: 'IBM Plex Sans', sans-serif;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: var(--sans); background: var(--bg); color: var(--text); }
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes excPulse { 0% { box-shadow: 0 0 0 0 rgba(255,107,107,0.6); } 70% { box-shadow: 0 0 0 5px rgba(255,107,107,0); } 100% { box-shadow: 0 0 0 0 rgba(255,107,107,0); } }
        @keyframes typingBounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-5px); opacity: 1; } }
        textarea { font-family: inherit; }
        button { font-family: inherit; }
        input, select { font-family: inherit; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--sans)", background: "var(--bg)", color: "var(--text)" }}>

        {/* HEADER */}
        <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, letterSpacing: "0.04em" }}>
            <div style={{ width: 28, height: 28, background: "linear-gradient(135deg, var(--accent), var(--accent2))", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⚡</div>
            FAILURE_LOGS
          </div>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            {[
              { dot: "var(--red)",   label: `${rawRecords.length} total failures` },
              { dot: "var(--green)", label: `${tree.length} domains` },
            ].map(({ dot, label }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 20, padding: "4px 12px", fontSize: 11, fontFamily: "var(--mono)" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: dot }} />
                {label}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

          {/* SIDEBAR */}
          <div style={{ width: 280, minWidth: 280, background: "var(--surface)", borderRight: "1px solid var(--border)", padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 24 }}>

            {/* Quick View */}
            <div>
              <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.1em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 10 }}>Quick View</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {QUICK_VIEWS.map(qv => {
                  const active = quickView === qv.key;
                  return (
                    <button key={qv.key} onClick={() => setQuickView(qv.key)} style={{ display: "flex", alignItems: "center", width: "100%", background: active ? qv.activeBg : "transparent", border: `1px solid ${active ? qv.activeBorder : "transparent"}`, borderRadius: 5, color: active ? qv.activeColor : "var(--text2)", fontSize: 11, fontWeight: 600, padding: "5px 10px", cursor: "pointer", textAlign: "left", letterSpacing: "0.2px", gap: 8 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? qv.activeColor : "currentColor", opacity: active ? 1 : 0.3, flexShrink: 0, boxShadow: active ? `0 0 6px ${qv.activeColor}` : "none" }} />
                      {qv.label}
                      <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 8, background: "rgba(255,255,255,0.06)", minWidth: 18, textAlign: "center" }}>
                        {quickCounts[qv.key] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Search */}
            <div>
              <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.1em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 10 }}>Search</div>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", fontSize: 13, pointerEvents: "none" }}>⌕</span>
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Name, ZOID, ZUID, ServerName…"
                  style={{ width: "100%", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "8px 10px 8px 32px", outline: "none" }} />
              </div>
            </div>

            {/* Flow Type */}
            <div>
              <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.1em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 10 }}>Flow Type</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[{ v: "Publish", color: "#f0883e" }, { v: "Signup", color: "#4f8ef7" }, { v: "Invite", color: "#7c5cfc" }, { v: "Upgrade", color: "#f5a623" }].map(({ v, color }) => (
                  <label key={v} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text2)" }}>
                    <input type="checkbox" checked={flowFilters[v] ?? true} onChange={e => setFlowFilters(f => ({ ...f, [v]: e.target.checked }))} style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }} />
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                    {v}
                  </label>
                ))}
              </div>
            </div>

            {/* Date Range */}
            <div>
              <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.1em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 10 }}>Date Range</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[["FROM", dateFrom, setDateFrom], ["TO", dateTo, setDateTo]].map(([label, val, setter]) => (
                  <div key={label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--text2)", fontFamily: "var(--mono)" }}>{label}</span>
                    <input type="date" value={val} onChange={e => setter(e.target.value)}
                      style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none" }} />
                  </div>
                ))}
              </div>
            </div>

            {/* Status Code */}
            <div>
              <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.1em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 10 }}>Status Code</div>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", fontSize: 13, pointerEvents: "none" }}>⌕</span>
                <input type="text" value={errCode} onChange={e => setErrCode(e.target.value)} placeholder="e.g. 400, 500…"
                  style={{ width: "100%", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "8px 10px 8px 32px", outline: "none" }} />
              </div>
            </div>

            <button onClick={resetFilters} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text2)", fontFamily: "var(--mono)", fontSize: 11, padding: "7px 14px", cursor: "pointer", width: "100%", letterSpacing: "0.05em" }}>
              ↺ RESET FILTERS
            </button>
          </div>

          {/* MAIN */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Toolbar */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)" }}>
                Showing <span style={{ color: "var(--accent)", fontWeight: 500 }}>{totalVisible}</span> of <span style={{ color: "var(--accent)", fontWeight: 500 }}>{rawRecords.length}</span> records
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setAllExpanded(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text2)", fontFamily: "var(--mono)", fontSize: 11, padding: "6px 12px", cursor: "pointer" }}>
                  {allExpanded ? "⊖ Collapse All" : "⊕ Expand All"}
                </button>
                <button onClick={() => loadData(true)} style={{ display: "flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg, var(--accent), var(--accent2))", border: "none", borderRadius: 6, color: "#fff", fontFamily: "var(--mono)", fontSize: 11, fontWeight: 500, padding: "6px 12px", cursor: "pointer" }}>
                  ↻ Fetch from CRM
                </button>
              </div>
            </div>

            {/* Tree */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {loading ? (
                <div style={{ padding: "30px 0" }}>
                  <div style={{ height: 2, background: "linear-gradient(90deg, transparent, var(--accent), var(--accent2), transparent)", backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite", borderRadius: 2, marginBottom: 8 }} />
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "16px 20px", color: "var(--text2)", gap: 12 }}>
                    <div style={{ fontSize: 12, color: "var(--text2)" }}>Fetching records…</div>
                  </div>
                </div>
              ) : tree.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", color: "var(--text3)", gap: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 36, opacity: 0.4 }}>⊘</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--text2)" }}>No matching records</div>
                  <div style={{ fontSize: 12, maxWidth: 280, lineHeight: 1.6 }}>Try adjusting your search or filter criteria.</div>
                </div>
              ) : tree.map((nameNode, i) => (
                <DomainNode key={i} nameNode={nameNode} allExpanded={allExpanded}
                  onOpenException={(rec) => setModalRec(rec)}
                  onFetchTrace={handleFetchTrace} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* EXCEPTION MODAL */}
      {modalRec && (
        <ExceptionModal
          rec={modalRec}
          onClose={() => setModalRec(null)}
          onAnalyze={(rec) => { setChatRec(rec); setChatOpen(true); }}
        />
      )}

      {/* CHAT WINDOW */}
      {chatOpen && (
        <ChatWindow contextRec={chatRec} onClose={() => setChatOpen(false)} />
      )}
    </>
  );
}
