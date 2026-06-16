use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::models::{DocumentRecord, EventRecord, ProposalRecord};
use crate::workspace;

#[derive(Clone)]
struct ServeState {
    root: Arc<PathBuf>,
    token: Arc<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentScopedQuery {
    document_id: Option<String>,
    since: Option<String>,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyRequest {
    body: String,
    #[serde(default = "default_reply_kind")]
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptProposalRequest {
    updated_document_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceResponse {
    root_path: String,
    mdreview_path: String,
    documents: Vec<DocumentRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentResponse {
    document: DocumentRecord,
    content: String,
}

pub fn run(workspace: Option<PathBuf>, port: u16, token: Option<String>) -> Result<(), String> {
    let root = resolve_workspace_root(workspace)?;
    let token = token.unwrap_or_else(|| generated_token(&root));

    workspace::ensure_workspace_layout(&root)?;
    refresh_document_index(&root)?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to start serve runtime: {error}"))?;
    runtime.block_on(run_server(root, port, token))
}

async fn run_server(root: PathBuf, port: u16, token: String) -> Result<(), String> {
    let state = ServeState {
        root: Arc::new(root),
        token: Arc::new(token),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/brief", get(index))
        .route("/doc/*relative_path", get(index))
        .route("/api/workspace", get(api_workspace))
        .route("/api/review-passes", get(api_review_passes))
        .route("/api/documents/:document_id", get(api_document))
        .route("/api/threads", get(api_threads))
        .route("/api/threads/:thread_id/reply", post(api_reply_thread))
        .route("/api/threads/:thread_id/resolve", post(api_resolve_thread))
        .route("/api/threads/:thread_id/reopen", post(api_reopen_thread))
        .route("/api/proposals", get(api_proposals))
        .route(
            "/api/proposals/:proposal_id/accept",
            post(api_accept_proposal),
        )
        .route(
            "/api/proposals/:proposal_id/reject",
            post(api_reject_proposal),
        )
        .route("/api/events", get(api_events))
        .route("/ws", get(ws_events))
        .with_state(state.clone());

    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Unable to bind {address}: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("Unable to read listener address: {error}"))?;
    println!(
        "Margent browser UI: http://127.0.0.1:{}/?token={}",
        local_addr.port(),
        state.token
    );
    println!("Workspace: {}", state.root.display());
    println!("Bind: 127.0.0.1 only; keep the token private.");

    axum::serve(listener, app)
        .await
        .map_err(|error| format!("Margent serve failed: {error}"))
}

async fn index(
    State(state): State<ServeState>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    Html(INDEX_HTML).into_response()
}

async fn api_workspace(
    State(state): State<ServeState>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(workspace_snapshot(&state.root))
}

async fn api_review_passes(
    State(state): State<ServeState>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(margent_core::review_context::list_review_passes(
        &state.root,
    ))
}

async fn api_document(
    State(state): State<ServeState>,
    AxumPath(document_id): AxumPath<String>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(load_document_response(&state.root, &document_id))
}

async fn api_threads(
    State(state): State<ServeState>,
    Query(query): Query<DocumentScopedQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    match query.document_id.as_deref() {
        Some(document_id) => json_result(workspace::load_threads_sorted(&state.root, document_id)),
        None => json_result(workspace::load_all_threads_sorted(&state.root)),
    }
}

async fn api_reply_thread(
    State(state): State<ServeState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
    Json(request): Json<ReplyRequest>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(workspace::add_thread_message(
        &state.root,
        &thread_id,
        &request.body,
        &request.kind,
        "user",
        "You",
        None,
        None,
    ))
}

async fn api_resolve_thread(
    State(state): State<ServeState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(workspace::resolve_thread(&state.root, &thread_id))
}

async fn api_reopen_thread(
    State(state): State<ServeState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(workspace::reopen_thread(&state.root, &thread_id))
}

async fn api_proposals(
    State(state): State<ServeState>,
    Query(query): Query<DocumentScopedQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(load_proposals(&state.root, query.document_id.as_deref()))
}

async fn api_accept_proposal(
    State(state): State<ServeState>,
    AxumPath(proposal_id): AxumPath<String>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
    request: Option<Json<AcceptProposalRequest>>,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(workspace::accept_proposal(
        &state.root,
        &proposal_id,
        request
            .as_ref()
            .and_then(|Json(payload)| payload.updated_document_text.as_deref()),
    ))
}

async fn api_reject_proposal(
    State(state): State<ServeState>,
    AxumPath(proposal_id): AxumPath<String>,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(workspace::reject_proposal(&state.root, &proposal_id))
}

async fn api_events(
    State(state): State<ServeState>,
    Query(query): Query<DocumentScopedQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    json_result(load_events_since(&state.root, query.since.as_deref()))
}

async fn ws_events(
    State(state): State<ServeState>,
    ws: WebSocketUpgrade,
    Query(query): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers, query.token.as_deref()) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Margent serve token.",
        );
    }

    ws.on_upgrade(move |socket| async move {
        let events_path = state.root.join(".mdreview/events.ndjson");
        let watch_dir = events_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| state.root.join(".mdreview"));
        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        let mut watcher = match RecommendedWatcher::new(
            move |_| {
                let _ = tx.send(());
            },
            NotifyConfig::default(),
        ) {
            Ok(watcher) => watcher,
            Err(_) => return,
        };
        if watcher
            .watch(&watch_dir, RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }

        let mut socket = socket;
        let _ = socket
            .send(Message::Text(
                json!({"event":"ready","kind":"workspace","body":"Margent serve connected"})
                    .to_string()
                    .into(),
            ))
            .await;
        while rx.recv().await.is_some() {
            if socket
                .send(Message::Text(
                    json!({"event":"refresh","kind":"events","body":"Workspace sidecar changed"})
                        .to_string()
                        .into(),
                ))
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

fn resolve_workspace_root(workspace: Option<PathBuf>) -> Result<PathBuf, String> {
    let start = match workspace {
        Some(path) => path,
        None => std::env::current_dir()
            .map_err(|error| format!("Unable to determine current directory: {error}"))?,
    };
    workspace::find_workspace_root(&start)
}

fn refresh_document_index(root: &Path) -> Result<Vec<DocumentRecord>, String> {
    let mut records = Vec::new();
    for path in workspace::list_markdown_files(root)? {
        let relative_path = workspace::relative_path_string(root, &path)?;
        let content = workspace::read_document_content(root, &relative_path)?;
        records.push(workspace::upsert_document_record(
            root,
            &relative_path,
            &content,
        )?);
    }
    records.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(records)
}

fn workspace_snapshot(root: &Path) -> Result<WorkspaceResponse, String> {
    let mdreview_path = workspace::ensure_workspace_layout(root)?;
    let mut documents = refresh_document_index(root)?;
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(WorkspaceResponse {
        root_path: root.to_string_lossy().to_string(),
        mdreview_path: mdreview_path.to_string_lossy().to_string(),
        documents,
    })
}

fn load_document_response(root: &Path, document_id: &str) -> Result<DocumentResponse, String> {
    let document = workspace::load_document_by_id(root, document_id)?;
    let content = workspace::read_document_content(root, &document.relative_path)?;
    Ok(DocumentResponse { document, content })
}

fn load_proposals(root: &Path, document_id: Option<&str>) -> Result<Vec<ProposalRecord>, String> {
    let mut proposals = workspace::load_all_proposals(root)?;
    if let Some(document_id) = document_id {
        proposals.retain(|proposal| proposal.document_id == document_id);
    }
    proposals.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(proposals)
}

fn load_events_since(root: &Path, since: Option<&str>) -> Result<Vec<EventRecord>, String> {
    let events = workspace::load_events(root)?;
    let Some(since) = since else {
        return Ok(events);
    };
    let offset = events
        .iter()
        .position(|event| event.id == since)
        .map(|index| index + 1)
        .unwrap_or(0);
    Ok(events.into_iter().skip(offset).collect())
}

fn authorized(state: &ServeState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    if query_token == Some(state.token.as_str()) {
        return true;
    }

    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value == state.token.as_str())
        .unwrap_or(false)
}

fn json_result<T: Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn generated_token(root: &Path) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    format!("margent-{}", &hex::encode(hasher.finalize())[..24])
}

fn default_reply_kind() -> String {
    "reply".to_string()
}

const INDEX_HTML: &str = r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Margent Serve</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171412;
      --muted: #6f665f;
      --paper: #fffdf8;
      --rail: #f3ecdf;
      --rule: #d7cab8;
      --accent: #245f5a;
      --danger: #8b3b1b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-serif, Georgia, serif;
      color: var(--ink);
      background: var(--paper);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 52px;
      padding: 10px 18px;
      color: #f8f0df;
      background: #1d1a18;
    }
    header strong { font-size: 18px; }
    #status { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .08em; }
    main {
      display: grid;
      grid-template-columns: minmax(190px, 260px) minmax(360px, 1fr) minmax(280px, 390px);
      min-height: calc(100vh - 52px);
    }
    nav, aside {
      border-right: 1px solid var(--rule);
      background: var(--rail);
      padding: 14px;
      overflow: auto;
    }
    aside {
      border-right: 0;
      border-left: 1px solid var(--rule);
      background: #faf5eb;
    }
    section.document {
      padding: 22px clamp(20px, 4vw, 56px);
      overflow: auto;
    }
    h1, h2, h3 { margin: 0 0 10px; }
    button, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--rule);
      background: #fffaf0;
      color: var(--ink);
      min-height: 30px;
      padding: 5px 9px;
      cursor: pointer;
    }
    button.primary { border-color: var(--accent); color: var(--accent); }
    button.danger { border-color: var(--danger); color: var(--danger); }
    button[disabled] { opacity: .5; cursor: not-allowed; }
    .doc-link {
      display: block;
      width: 100%;
      margin: 0 0 8px;
      text-align: left;
    }
    .doc-link[aria-current="page"] { border-color: var(--accent); background: #fff; }
    pre.document-body {
      min-height: 60vh;
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 15px/1.62 ui-serif, Georgia, serif;
    }
    .thread-card, .proposal-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--rule);
      background: #fffdf8;
      padding: 11px;
      margin: 0 0 12px;
    }
    .thread-card[data-status="resolved"] { opacity: .72; }
    .meta {
      color: var(--muted);
      font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .messages {
      display: grid;
      gap: 7px;
      border-top: 1px solid var(--rule);
      padding-top: 8px;
    }
    .message { margin: 0; }
    .message strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    textarea {
      width: 100%;
      min-height: 70px;
      resize: vertical;
      border: 1px solid var(--rule);
      background: #fff;
      color: var(--ink);
      padding: 8px;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 7px; }
    .empty { color: var(--muted); }
    .brief-body {
      display: grid;
      gap: 12px;
    }
    .brief-card {
      display: grid;
      gap: 9px;
      border: 1px solid var(--rule);
      background: #fffdf8;
      padding: 12px;
    }
    .brief-card h3 { margin: 0; }
    .brief-warning {
      margin: 0;
      color: var(--danger);
      font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .brief-anchor {
      margin: 0;
      border-left: 2px solid var(--rule);
      padding-left: 10px;
      color: var(--muted);
    }
    .proposal-edit {
      min-height: 160px;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      nav, aside { border: 0; border-bottom: 1px solid var(--rule); }
    }
  </style>
</head>
<body>
  <header>
    <strong>Margent</strong>
    <span id="status" role="status">Loading</span>
  </header>
  <main>
    <nav aria-label="Documents">
      <h2>Documents</h2>
      <button id="brief-link" class="doc-link" type="button">Review Brief</button>
      <div id="documents"></div>
    </nav>
    <section class="document" aria-label="Document">
      <h1 id="document-title">Document</h1>
      <pre id="document-body" class="document-body"></pre>
      <div id="brief-body" class="brief-body" hidden></div>
    </section>
    <aside aria-label="Review">
      <h2>Threads</h2>
      <div id="threads"></div>
      <h2>Proposals</h2>
      <div id="proposals"></div>
    </aside>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get("token");
    const state = { workspace: null, document: null, content: "", threads: [], proposals: [] };
    const statusEl = document.querySelector("#status");
    const headers = () => ({ "authorization": `Bearer ${token}`, "content-type": "application/json" });
    const encodeDocPath = (path) => path.split("/").map(encodeURIComponent).join("/");
    const isBriefRoute = () => location.pathname === "/brief";
    const routePath = () => location.pathname.startsWith("/doc/") ? decodeURIComponent(location.pathname.slice(5)) : null;
    document.querySelector("#brief-link").addEventListener("click", () => {
      history.pushState(null, "", `/brief?token=${encodeURIComponent(token)}`);
      loadAll();
    });

    if (!token) {
      statusEl.textContent = "Missing token";
    } else {
      connectSocket();
      loadAll();
    }

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    async function loadAll() {
      try {
        statusEl.textContent = "Refreshing";
        state.workspace = await api("/api/workspace");
        const documents = state.workspace.documents || [];
        if (isBriefRoute()) {
          state.document = null;
          renderDocuments(documents);
          state.threads = await api("/api/threads");
          state.proposals = await api("/api/proposals");
          renderBrief(documents);
          statusEl.textContent = "Ready";
          return;
        }
        const selectedPath = routePath();
        state.document = documents.find((doc) => doc.relativePath === selectedPath) || documents[0] || null;
        renderDocuments(documents);
        if (!state.document) {
          document.querySelector("#document-title").textContent = "No Markdown documents";
          document.querySelector("#document-body").textContent = "";
          document.querySelector("#threads").innerHTML = "<p class='empty'>No threads.</p>";
          document.querySelector("#proposals").innerHTML = "<p class='empty'>No proposals.</p>";
          statusEl.textContent = "Ready";
          return;
        }
        const docPayload = await api(`/api/documents/${encodeURIComponent(state.document.id)}`);
        state.document = docPayload.document;
        state.content = docPayload.content;
        state.threads = await api(`/api/threads?documentId=${encodeURIComponent(state.document.id)}`);
        state.proposals = await api(`/api/proposals?documentId=${encodeURIComponent(state.document.id)}`);
        renderDocument();
        renderThreads();
        renderProposals();
        statusEl.textContent = "Ready";
        const hash = location.hash.replace(/^#thread-/, "");
        if (hash) document.querySelector(`[data-thread-id="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: "center" });
      } catch (error) {
        statusEl.textContent = error.message || "Error";
      }
    }

    function renderDocuments(documents) {
      const root = document.querySelector("#documents");
      root.innerHTML = "";
      documents.forEach((doc) => {
        const button = document.createElement("button");
        button.className = "doc-link";
        button.type = "button";
        button.dataset.docPath = doc.relativePath;
        button.textContent = doc.relativePath;
        if (state.document?.id === doc.id) button.setAttribute("aria-current", "page");
        button.addEventListener("click", () => {
          history.pushState(null, "", `/doc/${encodeDocPath(doc.relativePath)}?token=${encodeURIComponent(token)}`);
          loadAll();
        });
        root.append(button);
      });
    }

    function renderDocument() {
      document.querySelector("#brief-body").hidden = true;
      document.querySelector("#document-body").hidden = false;
      document.querySelector("#document-title").textContent = state.document.relativePath;
      document.querySelector("#document-body").textContent = state.content;
    }

    function renderBrief(documents) {
      const title = document.querySelector("#document-title");
      const body = document.querySelector("#document-body");
      const brief = document.querySelector("#brief-body");
      const docsById = new Map(documents.map((doc) => [doc.id, doc]));
      const threadsById = new Map(state.threads.map((thread) => [thread.id, thread]));
      const proposals = state.proposals
        .filter((proposal) => proposal.status === "pending")
        .map((proposal) => ({ kind: "proposal", proposal, document: docsById.get(proposal.documentId), thread: proposal.threadIds.map((id) => threadsById.get(id)).find(Boolean), updatedAt: proposal.updatedAt || proposal.createdAt }))
        .filter((entry) => entry.document);
      const agentThreads = state.threads
        .filter((thread) => thread.status === "open" && !thread.reviewDone)
        .map((thread) => ({ kind: "agent-thread", thread, document: docsById.get(thread.documentId), latestAgentMessage: latestAgentMessage(thread), updatedAt: thread.updatedAt }))
        .filter((entry) => entry.document && entry.latestAgentMessage);
      const entries = [...proposals, ...agentThreads].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const resolvedCount = state.threads.filter((thread) => thread.status === "resolved").length;

      title.textContent = "Review Brief";
      body.hidden = true;
      brief.hidden = false;
      brief.innerHTML = "";
      document.querySelector("#threads").innerHTML = `<p class='empty'>${agentThreads.length} unanswered agent thread${agentThreads.length === 1 ? "" : "s"}.</p>`;
      document.querySelector("#proposals").innerHTML = `<p class='empty'>${proposals.length} pending proposal${proposals.length === 1 ? "" : "s"}.</p>`;

      if (!entries.length) {
        brief.innerHTML = "<p class='empty'>No pending proposals or unanswered agent replies.</p>";
      }
      entries.forEach((entry) => {
        brief.append(entry.kind === "proposal" ? renderBriefProposal(entry) : renderBriefThread(entry));
      });
      const resolved = document.createElement("details");
      resolved.innerHTML = `<summary>Resolved (${resolvedCount})</summary>`;
      brief.append(resolved);
    }

    function renderBriefProposal(entry) {
      const { proposal, document: doc, thread } = entry;
      const card = document.createElement("article");
      const older = proposal.baseContentHash !== doc.currentContentHash;
      card.className = "brief-card";
      card.dataset.briefKind = "proposal";
      card.dataset.docPath = doc.relativePath;
      card.dataset.proposalId = proposal.id;
      if (thread) card.dataset.threadId = thread.id;
      card.innerHTML = `
        <div class="meta">Proposal · ${escapeHtml(proposal.adapterId)} · ${escapeHtml(proposal.id)}</div>
        <h3>${escapeHtml(doc.relativePath)}</h3>
        ${older ? "<p class='brief-warning'>Applies to an older document version.</p>" : ""}
        ${thread?.anchor?.quote ? `<p class="brief-anchor">${escapeHtml(thread.anchor.quote)}</p>` : ""}
        <p>${escapeHtml(proposal.summary || proposal.assistantMessage || "Pending proposal")}</p>
        ${proposal.computedDiff ? `<pre>${escapeHtml(proposal.computedDiff)}</pre>` : ""}
        ${proposal.updatedDocumentText !== null ? `<textarea class="proposal-edit" aria-label="Edited proposal text">${escapeHtml(proposal.updatedDocumentText || "")}</textarea>` : ""}
        <div class="actions">
          <button class="primary" data-action="accept" ${older ? "disabled" : ""}>Accept</button>
          <button class="danger" data-action="reject">Reject</button>
          ${thread ? `<button data-action="open">Open Thread</button>` : ""}
        </div>
      `;
      card.querySelector('[data-action="accept"]')?.addEventListener("click", () => acceptProposal(proposal.id, card.querySelector(".proposal-edit")?.value));
      card.querySelector('[data-action="reject"]')?.addEventListener("click", () => rejectProposal(proposal.id));
      card.querySelector('[data-action="open"]')?.addEventListener("click", () => openDocThread(doc.relativePath, thread.id));
      return card;
    }

    function renderBriefThread(entry) {
      const { document: doc, thread, latestAgentMessage } = entry;
      const card = document.createElement("article");
      const older = (thread.lastReanchorContentHash || thread.anchor?.baseContentHash) !== doc.currentContentHash;
      card.className = "brief-card";
      card.dataset.briefKind = "agent-thread";
      card.dataset.docPath = doc.relativePath;
      card.dataset.threadId = thread.id;
      card.innerHTML = `
        <div class="meta">Agent Reply · ${escapeHtml(latestAgentMessage.authorName)} · ${escapeHtml(thread.id)}</div>
        <h3>${escapeHtml(doc.relativePath)}</h3>
        ${older ? "<p class='brief-warning'>Applies to an older document version.</p>" : ""}
        <p><strong>${escapeHtml(thread.title || "Thread")}</strong></p>
        ${thread.anchor?.quote ? `<p class="brief-anchor">${escapeHtml(thread.anchor.quote)}</p>` : ""}
        <p>${escapeHtml(latestAgentMessage.body)}</p>
        <textarea aria-label="Reply to ${escapeHtml(thread.title || thread.id)}" placeholder="Reply..."></textarea>
        <div class="actions">
          <button class="primary" data-action="reply">Reply</button>
          <button data-action="open">Open Thread</button>
        </div>
      `;
      card.querySelector('[data-action="reply"]').addEventListener("click", () => replyToThread(thread.id, card.querySelector("textarea").value));
      card.querySelector('[data-action="open"]').addEventListener("click", () => openDocThread(doc.relativePath, thread.id));
      return card;
    }

    function renderThreads() {
      const root = document.querySelector("#threads");
      root.innerHTML = "";
      if (!state.threads.length) {
        root.innerHTML = "<p class='empty'>No threads.</p>";
        return;
      }
      state.threads.forEach((thread) => {
        const card = document.createElement("article");
        card.className = "thread-card";
        card.dataset.threadId = thread.id;
        card.dataset.docPath = state.document.relativePath;
        card.dataset.status = thread.status;
        card.setAttribute("aria-label", `Thread ${thread.title}`);
        card.innerHTML = `
          <div class="meta">${thread.status} · ${thread.id}</div>
          <h3>${escapeHtml(thread.title || "Untitled thread")}</h3>
          <p>${escapeHtml(thread.anchor?.quote || "")}</p>
          <div class="messages">${thread.messages.map((m) => `<p class="message"><strong>${escapeHtml(m.authorName)}</strong><br>${escapeHtml(m.body)}</p>`).join("")}</div>
          <textarea aria-label="Reply to ${escapeHtml(thread.title || thread.id)}" placeholder="Reply..."></textarea>
          <div class="actions">
            <button class="primary" data-action="reply">Reply</button>
            <button data-action="${thread.status === "open" ? "resolve" : "reopen"}">${thread.status === "open" ? "Resolve" : "Reopen"}</button>
          </div>
        `;
        card.querySelector('[data-action="reply"]').addEventListener("click", () => replyToThread(thread.id, card.querySelector("textarea").value));
        card.querySelector('[data-action="resolve"], [data-action="reopen"]').addEventListener("click", () => thread.status === "open" ? resolveThread(thread.id) : reopenThread(thread.id));
        root.append(card);
      });
    }

    function renderProposals() {
      const root = document.querySelector("#proposals");
      root.innerHTML = "";
      const proposals = state.proposals.filter((proposal) => proposal.status === "pending");
      if (!proposals.length) {
        root.innerHTML = "<p class='empty'>No pending proposals.</p>";
        return;
      }
      proposals.forEach((proposal) => {
        const card = document.createElement("article");
        card.className = "proposal-card";
        card.dataset.proposalId = proposal.id;
        card.dataset.docPath = state.document.relativePath;
        card.innerHTML = `
          <div class="meta">${proposal.adapterId} · ${proposal.id}</div>
          <h3>${escapeHtml(proposal.summary || "Pending proposal")}</h3>
          <p>${escapeHtml(proposal.assistantMessage || "")}</p>
          <pre>${escapeHtml(proposal.computedDiff || "")}</pre>
          <div class="actions">
            <button class="primary" data-action="accept">Accept</button>
            <button class="danger" data-action="reject">Reject</button>
          </div>
        `;
        card.querySelector('[data-action="accept"]').addEventListener("click", () => acceptProposal(proposal.id));
        card.querySelector('[data-action="reject"]').addEventListener("click", () => rejectProposal(proposal.id));
        root.append(card);
      });
    }

    async function replyToThread(threadId, body) {
      if (!body.trim()) return;
      await api(`/api/threads/${encodeURIComponent(threadId)}/reply`, { method: "POST", body: JSON.stringify({ body }) });
      await loadAll();
    }
    async function resolveThread(threadId) {
      await api(`/api/threads/${encodeURIComponent(threadId)}/resolve`, { method: "POST" });
      await loadAll();
    }
    async function reopenThread(threadId) {
      await api(`/api/threads/${encodeURIComponent(threadId)}/reopen`, { method: "POST" });
      await loadAll();
    }
    async function acceptProposal(proposalId, updatedDocumentText) {
      await api(`/api/proposals/${encodeURIComponent(proposalId)}/accept`, {
        method: "POST",
        body: JSON.stringify({ updatedDocumentText }),
      });
      await loadAll();
    }
    async function rejectProposal(proposalId) {
      await api(`/api/proposals/${encodeURIComponent(proposalId)}/reject`, { method: "POST" });
      await loadAll();
    }
    function connectSocket() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);
      socket.addEventListener("message", () => loadAll());
      socket.addEventListener("close", () => setTimeout(connectSocket, 1200));
    }
    function openDocThread(relativePath, threadId) {
      history.pushState(null, "", `/doc/${encodeDocPath(relativePath)}?token=${encodeURIComponent(token)}#thread-${encodeURIComponent(threadId)}`);
      loadAll();
    }
    function latestAgentMessage(thread) {
      const latest = [...(thread.messages || [])].reverse().find((message) => message.authorType !== "system");
      if (!latest) return null;
      return latest.authorType === "agent" || latest.authorType === "assistant" || latest.agentId ? latest : null;
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    window.addEventListener("popstate", loadAll);
  </script>
</body>
</html>
"###;
