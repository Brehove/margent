use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use margent_core::change_set::compute_unified_diff;
use margent_core::deep_link::thread_deep_link;
use serde_json::{json, Value};

use crate::anchor_service;
use crate::models::{ProposalRecord, ThreadRecord};
use crate::workspace;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

pub fn run(workspace_path: Option<PathBuf>) -> Result<(), String> {
    let root = resolve_workspace_root(workspace_path)?;
    let server = McpServer { root };
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("Unable to read MCP stdin: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        if let Some(response) = server.handle_line(&line) {
            let encoded = serde_json::to_string(&response)
                .map_err(|error| format!("Unable to encode MCP response: {error}"))?;
            writeln!(stdout, "{encoded}")
                .map_err(|error| format!("Unable to write MCP response: {error}"))?;
            stdout
                .flush()
                .map_err(|error| format!("Unable to flush MCP response: {error}"))?;
        }
    }

    Ok(())
}

pub fn smoke_test(root: &Path) -> Result<usize, String> {
    let server = McpServer {
        root: root.to_path_buf(),
    };
    let initialize = server
        .handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        )
        .ok_or_else(|| "MCP initialize returned no response.".to_string())?;
    if let Some(error) = initialize.get("error") {
        return Err(format!("MCP initialize failed: {error}"));
    }

    let tools_response = server
        .handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)
        .ok_or_else(|| "MCP tools/list returned no response.".to_string())?;
    if let Some(error) = tools_response.get("error") {
        return Err(format!("MCP tools/list failed: {error}"));
    }
    let tool_count = tools_response
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| "MCP tools/list did not return a tools array.".to_string())?;

    let status_response =
        server.call_tool(&json!({ "name": "workspace_status", "arguments": {} }))?;
    if status_response.get("isError").and_then(Value::as_bool) == Some(true) {
        let message = status_response
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or("workspace_status returned an MCP tool error");
        return Err(message.to_string());
    }

    Ok(tool_count)
}

fn resolve_workspace_root(workspace_path: Option<PathBuf>) -> Result<PathBuf, String> {
    let candidate = match workspace_path {
        Some(path) => path,
        None => env::current_dir().map_err(|error| format!("Unable to read cwd: {error}"))?,
    };

    if candidate.join(".mdreview").is_dir() {
        return Ok(candidate);
    }

    workspace::find_workspace_root(&candidate)
}

struct McpServer {
    root: PathBuf,
}

impl McpServer {
    fn handle_line(&self, line: &str) -> Option<Value> {
        let request = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(error) => return Some(json_rpc_error(Value::Null, -32700, error.to_string())),
        };

        self.handle_request(request)
    }

    fn handle_request(&self, request: Value) -> Option<Value> {
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str);
        let Some(method) = method else {
            return id.map(|id| json_rpc_error(id, -32600, "Missing JSON-RPC method"));
        };

        let id = id?;
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "initialize" => Some(json_rpc_result(id, self.initialize_result(&params))),
            "ping" => Some(json_rpc_result(id, json!({}))),
            "tools/list" => Some(json_rpc_result(id, json!({ "tools": tools() }))),
            "tools/call" => match self.call_tool(&params) {
                Ok(result) => Some(json_rpc_result(id, result)),
                Err(error) => Some(json_rpc_error(id, -32602, error)),
            },
            _ => Some(json_rpc_error(
                id,
                -32601,
                format!("Unsupported MCP method: {method}"),
            )),
        }
    }

    fn initialize_result(&self, params: &Value) -> Value {
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(MCP_PROTOCOL_VERSION);
        let protocol_version = if requested == MCP_PROTOCOL_VERSION {
            requested
        } else {
            MCP_PROTOCOL_VERSION
        };

        json!({
            "protocolVersion": protocol_version,
            "capabilities": {
                "tools": {
                    "listChanged": false
                }
            },
            "serverInfo": {
                "name": "margent",
                "title": "Margent Review MCP",
                "version": env!("CARGO_PKG_VERSION")
            },
            "instructions": "Use Margent tools to inspect local Markdown review threads, add/reply/resolve threads, and create pending replacement proposals over the workspace sidecar data."
        })
    }

    fn call_tool(&self, params: &Value) -> Result<Value, String> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "tools/call requires params.name.".to_string())?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err("tools/call params.arguments must be an object.".into());
        }

        let outcome = match name {
            "workspace_status" => self.tool_workspace_status(),
            "list_documents" => self.tool_list_documents(),
            "read_document" => self.tool_read_document(&args),
            "create_markdown_file" => self.tool_create_markdown_file(&args),
            "rename_markdown_file" => self.tool_rename_markdown_file(&args),
            "delete_markdown_file" => self.tool_delete_markdown_file(&args),
            "outline_document" => self.tool_outline_document(&args),
            "list_threads" => self.tool_list_threads(&args),
            "get_thread_context" => self.tool_get_thread_context(&args),
            "add_thread" => self.tool_add_thread(&args),
            "reply_thread" => self.tool_reply_thread(&args),
            "delete_thread" => self.tool_delete_thread(&args),
            "delete_thread_message" => self.tool_delete_thread_message(&args),
            "resolve_thread" => self.tool_resolve_thread(&args),
            "reopen_thread" => self.tool_reopen_thread(&args),
            "list_proposals" => self.tool_list_proposals(&args),
            "get_proposal" => self.tool_get_proposal(&args),
            "list_pending_proposals" => self.tool_list_pending_proposals(&args),
            "accept_proposal" => self.tool_accept_proposal(&args),
            "reject_proposal" => self.tool_reject_proposal(&args),
            "propose_thread_replacement" => self.tool_propose_thread_replacement(&args),
            "reanchor_threads" => self.tool_reanchor_threads(&args),
            "events_since_cursor" => self.tool_events_since_cursor(&args),
            _ => return Err(format!("Unknown Margent MCP tool: {name}")),
        };

        Ok(match outcome {
            Ok(value) => tool_success(value),
            Err(error) => tool_error(error),
        })
    }

    fn tool_workspace_status(&self) -> Result<Value, String> {
        let documents = workspace::load_all_documents(&self.root)?;
        let threads = workspace::load_all_threads_sorted(&self.root)?;
        let proposals = workspace::load_all_proposals(&self.root)?;
        let open_threads = threads
            .iter()
            .filter(|thread| thread.status == "open")
            .count();
        let pending_proposals = proposals
            .iter()
            .filter(|proposal| proposal.status == "pending")
            .count();

        Ok(json!({
            "rootPath": self.root,
            "documents": documents.len(),
            "threads": threads.len(),
            "openThreads": open_threads,
            "proposals": proposals.len(),
            "pendingProposals": pending_proposals
        }))
    }

    fn tool_list_documents(&self) -> Result<Value, String> {
        let mut documents = workspace::load_all_documents(&self.root)?;
        documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

        Ok(json!({
            "documents": documents.into_iter().map(|document| json!({
                "id": document.id,
                "relativePath": document.relative_path,
                "displayName": document.display_name,
                "updatedAt": document.updated_at,
                "wordCount": document.word_count,
                "currentContentHash": document.current_content_hash,
                "headingIndex": document.heading_index
            })).collect::<Vec<_>>()
        }))
    }

    fn tool_read_document(&self, args: &Value) -> Result<Value, String> {
        let document = self.resolve_document_arg(args)?;
        let content = workspace::read_document_content(&self.root, &document.relative_path)?;

        Ok(json!({
            "document": document,
            "content": content
        }))
    }

    fn tool_create_markdown_file(&self, args: &Value) -> Result<Value, String> {
        let relative_path = required_string(args, "relativePath")?;
        let content = optional_string(args, "content").unwrap_or_default();
        let document = workspace::create_markdown_file(&self.root, &relative_path, &content)?;
        Ok(json!({ "document": document, "action": "created" }))
    }

    fn tool_rename_markdown_file(&self, args: &Value) -> Result<Value, String> {
        let from = required_string(args, "fromRelativePath")?;
        let to = required_string(args, "toRelativePath")?;
        let document = workspace::rename_markdown_file(&self.root, &from, &to)?;
        Ok(json!({ "document": document, "fromRelativePath": from, "action": "renamed" }))
    }

    fn tool_delete_markdown_file(&self, args: &Value) -> Result<Value, String> {
        require_confirm(args, "delete this Markdown file and its sidecars")?;
        let relative_path = required_string(args, "relativePath")?;
        let document = workspace::delete_markdown_file(&self.root, &relative_path)?;
        Ok(json!({ "document": document, "action": "deleted" }))
    }

    fn tool_outline_document(&self, args: &Value) -> Result<Value, String> {
        let document = self.resolve_document_arg(args)?;
        let content = workspace::read_document_content(&self.root, &document.relative_path)?;
        let heading_index = workspace::extract_heading_index(&content);
        Ok(json!({ "document": document, "headingIndex": heading_index }))
    }

    fn tool_list_threads(&self, args: &Value) -> Result<Value, String> {
        let status = optional_string(args, "status");
        let documents = workspace::load_all_documents(&self.root)?;
        let by_id: HashMap<_, _> = documents
            .iter()
            .map(|document| (document.id.clone(), document))
            .collect();

        let mut threads = if has_document_arg(args) {
            let document = self.resolve_document_arg(args)?;
            workspace::load_threads_sorted(&self.root, &document.id)?
        } else {
            workspace::load_all_threads_sorted(&self.root)?
        };

        if let Some(status) = status.as_deref() {
            threads.retain(|thread| thread.status == status);
        }

        Ok(json!({
            "threads": threads.into_iter().map(|thread| {
                let document = by_id.get(&thread.document_id);
                json!({
                    "id": thread.id,
                    "documentId": thread.document_id,
                    "relativePath": document.map(|document| document.relative_path.clone()),
                    "deepLink": document.map(|document| {
                        thread_deep_link(
                            self.root.to_string_lossy().as_ref(),
                            &document.relative_path,
                            &thread.id,
                        )
                    }),
                    "title": thread.title,
                    "status": thread.status,
                    "createdAt": thread.created_at,
                    "updatedAt": thread.updated_at,
                    "messageCount": thread.messages.len(),
                    "anchor": thread.anchor,
                    "linkedProposalIds": thread.linked_proposal_ids
                })
            }).collect::<Vec<_>>()
        }))
    }

    fn tool_get_thread_context(&self, args: &Value) -> Result<Value, String> {
        let thread_id = required_string(args, "threadId")?;
        let mut thread = workspace::load_thread(&self.root, &thread_id)?;
        let document = workspace::load_document_by_id(&self.root, &thread.document_id)?;
        let content = workspace::read_document_content(&self.root, &document.relative_path)?;
        self.refresh_thread_anchor(&content, &mut thread)?;
        let anchor_text = workspace::extract_anchor_text(&content, &thread.anchor).ok();
        let include_document = optional_bool(args, "includeDocument").unwrap_or(true);

        Ok(json!({
            "deepLink": thread_deep_link(
                self.root.to_string_lossy().as_ref(),
                &document.relative_path,
                &thread.id,
            ),
            "thread": thread,
            "document": document,
            "anchorText": anchor_text,
            "content": if include_document { Some(content) } else { None }
        }))
    }

    fn tool_add_thread(&self, args: &Value) -> Result<Value, String> {
        let quote = required_string(args, "quote")?;
        let body = required_string(args, "body")?;
        let title = optional_string(args, "title").unwrap_or_default();
        let occurrence = optional_usize(args, "occurrence").unwrap_or(1);
        let document = self.resolve_document_arg(args)?;
        let content = workspace::read_document_content(&self.root, &document.relative_path)?;
        let anchor = workspace::build_anchor_from_quote(&document, &content, &quote, occurrence)?;
        let (agent_id, author_name) = agent_identity(args);
        let thread = workspace::create_thread(
            &self.root,
            &document,
            &title,
            &body,
            anchor,
            &agent_id,
            "agent",
            &author_name,
            Some(&agent_id),
        )?;

        Ok(json!({
            "thread": thread,
            "document": document
        }))
    }

    fn tool_reply_thread(&self, args: &Value) -> Result<Value, String> {
        let thread_id = required_string(args, "threadId")?;
        let body = required_string(args, "body")?;
        let kind = optional_string(args, "kind").unwrap_or_else(|| "reply".into());
        let (agent_id, author_name) = agent_identity(args);
        let reply_to_message_id = match optional_usize(args, "replyToMessageOrdinal") {
            Some(ordinal) => {
                let thread = workspace::load_thread(&self.root, &thread_id)?;
                Some(workspace::resolve_message_by_ordinal(&thread, ordinal)?.id)
            }
            None => optional_string(args, "replyToMessageId"),
        };
        let thread = workspace::add_thread_message(
            &self.root,
            &thread_id,
            &body,
            &kind,
            "agent",
            &author_name,
            Some(&agent_id),
            reply_to_message_id.as_deref(),
        )?;

        Ok(json!({ "thread": thread }))
    }

    fn tool_delete_thread(&self, args: &Value) -> Result<Value, String> {
        require_confirm(args, "delete this thread")?;
        let thread_id = required_string(args, "threadId")?;
        let thread = workspace::delete_thread(&self.root, &thread_id)?;
        Ok(json!({ "thread": thread, "action": "deleted" }))
    }

    fn tool_delete_thread_message(&self, args: &Value) -> Result<Value, String> {
        require_confirm(args, "delete this thread message")?;
        let thread_id = required_string(args, "threadId")?;
        let message_ordinal = required_usize(args, "messageOrdinal")?;
        let thread = workspace::load_thread(&self.root, &thread_id)?;
        let message = workspace::resolve_message_by_ordinal(&thread, message_ordinal)?;
        let updated_thread =
            workspace::delete_thread_message(&self.root, &thread_id, message_ordinal)?;
        let deleted_thread = updated_thread.is_none();
        Ok(json!({
            "thread": updated_thread,
            "deletedMessage": message,
            "deletedThread": deleted_thread,
            "action": "messageDeleted"
        }))
    }

    fn tool_resolve_thread(&self, args: &Value) -> Result<Value, String> {
        let thread_id = required_string(args, "threadId")?;
        let thread = workspace::resolve_thread(&self.root, &thread_id)?;
        Ok(json!({ "thread": thread }))
    }

    fn tool_reopen_thread(&self, args: &Value) -> Result<Value, String> {
        let thread_id = required_string(args, "threadId")?;
        let thread = workspace::reopen_thread(&self.root, &thread_id)?;
        Ok(json!({ "thread": thread }))
    }

    fn tool_list_proposals(&self, args: &Value) -> Result<Value, String> {
        let document_filter = if has_document_arg(args) {
            Some(self.resolve_document_arg(args)?.id)
        } else {
            None
        };
        let status = optional_string(args, "status");
        let mut proposals = workspace::load_all_proposals(&self.root)?;
        if let Some(document_id) = document_filter.as_deref() {
            proposals.retain(|proposal| proposal.document_id == document_id);
        }
        if let Some(status) = status.as_deref() {
            proposals.retain(|proposal| proposal.status == status);
        }
        proposals.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(json!({ "proposals": proposals }))
    }

    fn tool_get_proposal(&self, args: &Value) -> Result<Value, String> {
        let proposal_id = required_string(args, "proposalId")?;
        let proposal = workspace::load_proposal(&self.root, &proposal_id)?;
        let document = workspace::load_document_by_id(&self.root, &proposal.document_id).ok();
        Ok(json!({ "proposal": proposal, "document": document }))
    }

    fn tool_list_pending_proposals(&self, args: &Value) -> Result<Value, String> {
        let document_filter = if has_document_arg(args) {
            Some(self.resolve_document_arg(args)?.id)
        } else {
            None
        };
        let mut proposals = workspace::load_all_proposals(&self.root)?;
        proposals.retain(|proposal| proposal.status == "pending");
        if let Some(document_id) = document_filter.as_deref() {
            proposals.retain(|proposal| proposal.document_id == document_id);
        }
        proposals.sort_by(|left, right| left.created_at.cmp(&right.created_at));

        Ok(json!({ "proposals": proposals }))
    }

    fn tool_accept_proposal(&self, args: &Value) -> Result<Value, String> {
        let proposal_id = required_string(args, "proposalId")?;
        let result = workspace::accept_proposal(&self.root, &proposal_id, None)?;
        Ok(json!({ "result": result, "action": "accepted" }))
    }

    fn tool_reject_proposal(&self, args: &Value) -> Result<Value, String> {
        let proposal_id = required_string(args, "proposalId")?;
        let result = workspace::reject_proposal(&self.root, &proposal_id)?;
        Ok(json!({ "result": result, "action": "rejected" }))
    }

    fn tool_propose_thread_replacement(&self, args: &Value) -> Result<Value, String> {
        let thread_id = required_string(args, "threadId")?;
        let replacement_text = required_string(args, "replacementText")?;
        let summary = optional_string(args, "summary")
            .unwrap_or_else(|| "MCP replacement proposal".to_string());
        let assistant_message =
            optional_string(args, "assistantMessage").unwrap_or_else(|| summary.clone());
        let should_resolve = optional_bool(args, "resolveThread").unwrap_or(false);
        let mut thread = workspace::load_thread(&self.root, &thread_id)?;
        let document = workspace::load_document_by_id(&self.root, &thread.document_id)?;
        let content = workspace::read_document_content(&self.root, &document.relative_path)?;
        self.refresh_thread_anchor(&content, &mut thread)?;

        if thread.anchor.state == "detached" {
            return Err(
                "Thread anchor is detached; refusing to create a targeted replacement proposal."
                    .into(),
            );
        }

        let anchored_text = workspace::extract_anchor_text(&content, &thread.anchor)?;
        let updated_document_text =
            workspace::replace_anchor_text(&content, &thread.anchor, &replacement_text)?;
        let now = workspace::now_rfc3339()?;
        let proposal_id = workspace::next_id("proposal")?;
        let proposal = ProposalRecord {
            schema_version: 1,
            id: proposal_id,
            document_id: document.id.clone(),
            thread_ids: vec![thread.id.clone()],
            adapter_id: "mcp".into(),
            created_at: now.clone(),
            updated_at: now.clone(),
            status: "pending".into(),
            base_content_hash: document.current_content_hash.clone(),
            response_mode: "updated_document".into(),
            summary,
            assistant_message,
            updated_document_text: Some(updated_document_text.clone()),
            unified_diff: None,
            computed_diff: compute_unified_diff(&content, &updated_document_text),
            warnings: Vec::new(),
            resolve_thread_ids: if should_resolve {
                vec![thread.id.clone()]
            } else {
                Vec::new()
            },
            stderr: None,
            error_message: None,
            extra: Default::default(),
        };

        workspace::save_proposal(&self.root, &proposal)?;
        if !thread.linked_proposal_ids.contains(&proposal.id) {
            thread.linked_proposal_ids.push(proposal.id.clone());
            thread.updated_at = now;
            workspace::save_thread(&self.root, &thread)?;
        }
        workspace::append_event(
            &self.root,
            "proposal.received",
            Some(&thread.id),
            Some(&document.id),
            Some(&proposal.id),
            None,
        )?;

        Ok(json!({
            "proposal": proposal,
            "thread": thread,
            "document": document,
            "anchoredText": anchored_text,
            "replacementText": replacement_text
        }))
    }

    fn tool_reanchor_threads(&self, args: &Value) -> Result<Value, String> {
        let dry_run = optional_bool(args, "dryRun").unwrap_or(false);
        let documents = if has_document_arg(args) {
            vec![self.resolve_document_arg(args)?]
        } else {
            workspace::load_all_documents(&self.root)?
        };
        let mut stats = json!({
            "documents": documents.len(),
            "threads": 0usize,
            "changedThreads": 0usize,
            "needsReview": 0usize,
            "detached": 0usize,
            "dryRun": dry_run
        });

        for document in documents {
            let content = workspace::read_document_content(&self.root, &document.relative_path)?;
            let heading_index = workspace::extract_heading_index(&content);
            for mut thread in workspace::load_threads_sorted(&self.root, &document.id)? {
                increment_stat(&mut stats, "threads");
                let changed =
                    anchor_service::reattach_anchor(&mut thread.anchor, &content, &heading_index);
                if changed {
                    increment_stat(&mut stats, "changedThreads");
                    if !dry_run {
                        thread.updated_at = workspace::now_rfc3339()?;
                        workspace::save_thread(&self.root, &thread)?;
                    }
                }
                match thread.anchor.state.as_str() {
                    "needs_review" => increment_stat(&mut stats, "needsReview"),
                    "detached" => increment_stat(&mut stats, "detached"),
                    _ => {}
                }
            }
        }

        Ok(stats)
    }

    fn tool_events_since_cursor(&self, args: &Value) -> Result<Value, String> {
        let since_event_id = optional_string(args, "sinceEventId");
        let events = events_since(
            workspace::load_events(&self.root)?,
            since_event_id.as_deref(),
        )?;
        let count = events.len();
        Ok(json!({
            "sinceEventId": since_event_id,
            "events": events,
            "count": count
        }))
    }

    fn resolve_document_arg(&self, args: &Value) -> Result<crate::models::DocumentRecord, String> {
        if let Some(document_id) = optional_string(args, "documentId") {
            return workspace::load_document_by_id(&self.root, &document_id);
        }
        workspace::resolve_document(&self.root, optional_string(args, "relativePath").as_deref())
    }

    fn refresh_thread_anchor(
        &self,
        content: &str,
        thread: &mut ThreadRecord,
    ) -> Result<(), String> {
        let heading_index = workspace::extract_heading_index(content);
        if anchor_service::reattach_anchor(&mut thread.anchor, content, &heading_index) {
            thread.updated_at = workspace::now_rfc3339()?;
            workspace::save_thread(&self.root, thread)?;
        }
        Ok(())
    }
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn json_rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into()
        }
    })
}

fn tool_success(structured: Value) -> Value {
    let text = serde_json::to_string_pretty(&structured).unwrap_or_else(|_| structured.to_string());
    json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ],
        "structuredContent": structured,
        "isError": false
    })
}

fn tool_error(message: String) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": message
            }
        ],
        "isError": true
    })
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    optional_string(args, key).ok_or_else(|| format!("Missing required argument: {key}"))
}

fn required_usize(args: &Value, key: &str) -> Result<usize, String> {
    optional_usize(args, key).ok_or_else(|| format!("Missing required integer argument: {key}"))
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn optional_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn require_confirm(args: &Value, action: &str) -> Result<(), String> {
    if optional_bool(args, "confirm") == Some(true) {
        Ok(())
    } else {
        Err(format!("Pass confirm=true to {action}."))
    }
}

fn has_document_arg(args: &Value) -> bool {
    optional_string(args, "relativePath").is_some() || optional_string(args, "documentId").is_some()
}

fn agent_identity(args: &Value) -> (String, String) {
    let agent_id = optional_string(args, "agentId").unwrap_or_else(|| "mcp".into());
    let author_name = optional_string(args, "authorName").unwrap_or_else(|| "Margent MCP".into());
    (agent_id, author_name)
}

fn increment_stat(stats: &mut Value, key: &str) {
    let next = stats.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
    stats[key] = json!(next);
}

fn events_since(
    events: Vec<crate::models::EventRecord>,
    since_event_id: Option<&str>,
) -> Result<Vec<crate::models::EventRecord>, String> {
    let Some(since_event_id) = since_event_id else {
        return Ok(events);
    };
    let Some(index) = events.iter().position(|event| event.id == since_event_id) else {
        return Err(format!(
            "Event {since_event_id} was not found in this workspace."
        ));
    };
    Ok(events.into_iter().skip(index + 1).collect())
}

fn tools() -> Vec<Value> {
    vec![
        tool_schema(
            "workspace_status",
            "Workspace Status",
            "Return counts for documents, threads, open threads, proposals, and pending proposals.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "list_documents",
            "List Documents",
            "List Markdown documents indexed in the Margent workspace.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "read_document",
            "Read Document",
            "Read an indexed Markdown document. Omit relativePath only when the workspace has one document.",
            document_arg_schema(),
        ),
        tool_schema(
            "create_markdown_file",
            "Create Markdown File",
            "Create a new Markdown document inside the workspace and index it.",
            json!({
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string" },
                    "content": { "type": "string", "default": "" }
                },
                "required": ["relativePath"],
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "rename_markdown_file",
            "Rename Markdown File",
            "Rename an indexed Markdown document and retarget its sidecars.",
            json!({
                "type": "object",
                "properties": {
                    "fromRelativePath": { "type": "string" },
                    "toRelativePath": { "type": "string" }
                },
                "required": ["fromRelativePath", "toRelativePath"],
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "delete_markdown_file",
            "Delete Markdown File",
            "Delete a Markdown document and sidecars after saving a snapshot. Requires confirm=true.",
            json!({
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string" },
                    "confirm": { "type": "boolean" }
                },
                "required": ["relativePath", "confirm"],
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "outline_document",
            "Outline Document",
            "Return the Markdown heading index for a document.",
            document_arg_schema(),
        ),
        tool_schema(
            "list_threads",
            "List Threads",
            "List threads across the workspace, or for one document when relativePath/documentId is provided.",
            json!({
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string" },
                    "documentId": { "type": "string" },
                    "status": { "type": "string", "enum": ["open", "resolved", "archived"] }
                },
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "get_thread_context",
            "Get Thread Context",
            "Return a thread, its document record, anchor text, messages, and optionally full document content.",
            json!({
                "type": "object",
                "properties": {
                    "threadId": { "type": "string" },
                    "includeDocument": { "type": "boolean", "default": true }
                },
                "required": ["threadId"],
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "add_thread",
            "Add Thread",
            "Create a new anchored review thread on a quote in a Markdown document.",
            json!({
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string" },
                    "documentId": { "type": "string" },
                    "quote": { "type": "string" },
                    "body": { "type": "string" },
                    "title": { "type": "string" },
                    "occurrence": { "type": "integer", "minimum": 1, "default": 1 },
                    "agentId": { "type": "string", "default": "mcp" },
                    "authorName": { "type": "string", "default": "Margent MCP" }
                },
                "required": ["quote", "body"],
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "reply_thread",
            "Reply Thread",
            "Add an agent-authored reply to an existing review thread.",
            json!({
                "type": "object",
                "properties": {
                    "threadId": { "type": "string" },
                    "body": { "type": "string" },
                    "kind": { "type": "string", "default": "reply" },
                    "replyToMessageId": { "type": "string" },
                    "replyToMessageOrdinal": { "type": "integer", "minimum": 1 },
                    "agentId": { "type": "string", "default": "mcp" },
                    "authorName": { "type": "string", "default": "Margent MCP" }
                },
                "required": ["threadId", "body"],
                "additionalProperties": false
            }),
        ),
        thread_id_confirm_tool_schema(
            "delete_thread",
            "Delete Thread",
            "Delete a thread. Requires confirm=true.",
        ),
        tool_schema(
            "delete_thread_message",
            "Delete Thread Message",
            "Delete one message by 1-based ordinal. Requires confirm=true.",
            json!({
                "type": "object",
                "properties": {
                    "threadId": { "type": "string" },
                    "messageOrdinal": { "type": "integer", "minimum": 1 },
                    "confirm": { "type": "boolean" }
                },
                "required": ["threadId", "messageOrdinal", "confirm"],
                "additionalProperties": false
            }),
        ),
        thread_id_tool_schema("resolve_thread", "Resolve Thread", "Mark a thread resolved."),
        thread_id_tool_schema("reopen_thread", "Reopen Thread", "Reopen a resolved thread."),
        tool_schema(
            "list_proposals",
            "List Proposals",
            "List proposals, optionally filtered by document and status.",
            json!({
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string" },
                    "documentId": { "type": "string" },
                    "status": { "type": "string" }
                },
                "additionalProperties": false
            }),
        ),
        proposal_id_tool_schema("get_proposal", "Get Proposal", "Return a proposal by ID."),
        tool_schema(
            "list_pending_proposals",
            "List Pending Proposals",
            "List pending revision proposals, optionally limited to one document.",
            document_arg_schema(),
        ),
        proposal_id_tool_schema(
            "accept_proposal",
            "Accept Proposal",
            "Hash-gated apply of a pending proposal to its document.",
        ),
        proposal_id_tool_schema(
            "reject_proposal",
            "Reject Proposal",
            "Reject a pending or stale proposal.",
        ),
        tool_schema(
            "propose_thread_replacement",
            "Propose Thread Replacement",
            "Create a pending proposal by replacing the selected thread anchor text with replacementText.",
            json!({
                "type": "object",
                "properties": {
                    "threadId": { "type": "string" },
                    "replacementText": { "type": "string" },
                    "summary": { "type": "string" },
                    "assistantMessage": { "type": "string" },
                    "resolveThread": { "type": "boolean", "default": false }
                },
                "required": ["threadId", "replacementText"],
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "reanchor_threads",
            "Reanchor Threads",
            "Refresh persisted thread anchors for one document or the full workspace.",
            json!({
                "type": "object",
                "properties": {
                    "relativePath": { "type": "string" },
                    "documentId": { "type": "string" },
                    "dryRun": { "type": "boolean", "default": false }
                },
                "additionalProperties": false
            }),
        ),
        tool_schema(
            "events_since_cursor",
            "Events Since Cursor",
            "Return workspace events after sinceEventId, or all events when omitted.",
            json!({
                "type": "object",
                "properties": {
                    "sinceEventId": { "type": "string" }
                },
                "additionalProperties": false
            }),
        ),
    ]
}

fn tool_schema(name: &str, title: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema
    })
}

fn document_arg_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "relativePath": { "type": "string" },
            "documentId": { "type": "string" }
        },
        "additionalProperties": false
    })
}

fn thread_id_tool_schema(name: &str, title: &str, description: &str) -> Value {
    tool_schema(
        name,
        title,
        description,
        json!({
            "type": "object",
            "properties": {
                "threadId": { "type": "string" }
            },
            "required": ["threadId"],
            "additionalProperties": false
        }),
    )
}

fn thread_id_confirm_tool_schema(name: &str, title: &str, description: &str) -> Value {
    tool_schema(
        name,
        title,
        description,
        json!({
            "type": "object",
            "properties": {
                "threadId": { "type": "string" },
                "confirm": { "type": "boolean" }
            },
            "required": ["threadId", "confirm"],
            "additionalProperties": false
        }),
    )
}

fn proposal_id_tool_schema(name: &str, title: &str, description: &str) -> Value {
    tool_schema(
        name,
        title,
        description,
        json!({
            "type": "object",
            "properties": {
                "proposalId": { "type": "string" }
            },
            "required": ["proposalId"],
            "additionalProperties": false
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        env::temp_dir().join(margent_core::id::new_id(&format!("margent_mcp_{label}")))
    }

    fn setup_workspace() -> (PathBuf, McpServer) {
        let root = temp_root("workspace");
        fs::create_dir_all(&root).expect("workspace dir");
        fs::write(root.join("doc.md"), "# Title\n\nTarget sentence.\n").expect("document");
        workspace::ensure_workspace_layout(&root).expect("layout");
        let content = workspace::read_document_content(&root, "doc.md").expect("content");
        workspace::upsert_document_record(&root, "doc.md", &content).expect("document record");
        let server = McpServer { root: root.clone() };
        (root, server)
    }

    fn call_tool(server: &McpServer, name: &str, arguments: Value) -> Value {
        let response = server
            .call_tool(&json!({ "name": name, "arguments": arguments }))
            .expect("tool call");
        assert_eq!(
            response.get("isError").and_then(Value::as_bool),
            Some(false)
        );
        response
            .get("structuredContent")
            .cloned()
            .expect("structured content")
    }

    #[test]
    fn lists_mcp_tools() {
        let (_, server) = setup_workspace();
        let response = server
            .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .expect("response");
        let tools = response["result"]["tools"].as_array().expect("tools array");
        for name in [
            "list_documents",
            "read_document",
            "create_markdown_file",
            "rename_markdown_file",
            "delete_markdown_file",
            "outline_document",
            "list_threads",
            "get_thread_context",
            "add_thread",
            "reply_thread",
            "delete_thread",
            "delete_thread_message",
            "resolve_thread",
            "reopen_thread",
            "list_proposals",
            "get_proposal",
            "accept_proposal",
            "reject_proposal",
            "propose_thread_replacement",
            "reanchor_threads",
            "events_since_cursor",
        ] {
            assert!(tools.iter().any(|tool| tool["name"] == name), "{name}");
        }
    }

    #[test]
    fn adds_replies_and_proposes_thread_replacement() {
        let (root, server) = setup_workspace();
        let added = call_tool(
            &server,
            "add_thread",
            json!({
                "relativePath": "doc.md",
                "quote": "Target sentence.",
                "body": "Tighten this."
            }),
        );
        let thread_id = added["thread"]["id"].as_str().expect("thread id");

        let replied = call_tool(
            &server,
            "reply_thread",
            json!({
                "threadId": thread_id,
                "body": "Working on it."
            }),
        );
        assert_eq!(replied["thread"]["messages"].as_array().unwrap().len(), 2);

        let proposed = call_tool(
            &server,
            "propose_thread_replacement",
            json!({
                "threadId": thread_id,
                "replacementText": "Sharper sentence."
            }),
        );
        assert_eq!(proposed["anchoredText"], "Target sentence.");
        assert_eq!(proposed["proposal"]["status"], "pending");

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn mcp_parity_tools_cover_files_proposals_reanchor_and_events() {
        let (root, server) = setup_workspace();

        let created = call_tool(
            &server,
            "create_markdown_file",
            json!({
                "relativePath": "notes/new.md",
                "content": "# New\n\nBody.\n"
            }),
        );
        assert_eq!(created["action"], "created");

        let renamed = call_tool(
            &server,
            "rename_markdown_file",
            json!({
                "fromRelativePath": "notes/new.md",
                "toRelativePath": "notes/renamed.md"
            }),
        );
        assert_eq!(renamed["document"]["relativePath"], "notes/renamed.md");

        let delete_without_confirm = server
            .call_tool(&json!({
                "name": "delete_markdown_file",
                "arguments": { "relativePath": "notes/renamed.md" }
            }))
            .expect("delete tool response");
        assert_eq!(
            delete_without_confirm
                .get("isError")
                .and_then(Value::as_bool),
            Some(true)
        );

        let deleted = call_tool(
            &server,
            "delete_markdown_file",
            json!({
                "relativePath": "notes/renamed.md",
                "confirm": true
            }),
        );
        assert_eq!(deleted["action"], "deleted");

        let added = call_tool(
            &server,
            "add_thread",
            json!({
                "relativePath": "doc.md",
                "quote": "Target sentence.",
                "body": "Tighten this."
            }),
        );
        let thread_id = added["thread"]["id"].as_str().expect("thread id");
        let listed_threads = call_tool(&server, "list_threads", json!({ "status": "open" }));
        let thread_deep_link = listed_threads["threads"][0]["deepLink"]
            .as_str()
            .expect("thread deep link");
        assert!(thread_deep_link.starts_with("margent://open?"));
        assert!(thread_deep_link.contains("doc=doc.md"));
        assert!(thread_deep_link.contains(&format!("thread={thread_id}")));

        let context = call_tool(
            &server,
            "get_thread_context",
            json!({ "threadId": thread_id, "includeDocument": false }),
        );
        assert_eq!(context["deepLink"], thread_deep_link);

        let proposed = call_tool(
            &server,
            "propose_thread_replacement",
            json!({
                "threadId": thread_id,
                "replacementText": "Sharper sentence."
            }),
        );
        let proposal_id = proposed["proposal"]["id"].as_str().expect("proposal id");

        let listed = call_tool(&server, "list_proposals", json!({ "status": "pending" }));
        assert_eq!(listed["proposals"].as_array().expect("proposals").len(), 1);

        let shown = call_tool(
            &server,
            "get_proposal",
            json!({ "proposalId": proposal_id }),
        );
        assert_eq!(shown["proposal"]["id"], proposal_id);

        let rejected = call_tool(
            &server,
            "reject_proposal",
            json!({ "proposalId": proposal_id }),
        );
        assert_eq!(rejected["result"]["proposal"]["status"], "rejected");

        let reanchored = call_tool(
            &server,
            "reanchor_threads",
            json!({ "relativePath": "doc.md", "dryRun": true }),
        );
        assert_eq!(reanchored["documents"], 1);
        assert_eq!(reanchored["threads"], 1);

        let events = call_tool(&server, "events_since_cursor", json!({}));
        assert!(events["count"].as_u64().expect("event count") >= 1);

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn agent_native_acceptance_suite_is_env_gated() {
        if env::var("MARGENT_RUN_AGENT_NATIVE_ACCEPTANCE")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }

        let (root, server) = setup_workspace();
        let added = call_tool(
            &server,
            "add_thread",
            json!({
                "relativePath": "doc.md",
                "quote": "Target sentence.",
                "body": "Please make this more concrete.",
                "agentId": "acceptance",
                "authorName": "Acceptance Agent"
            }),
        );
        let thread_id = added["thread"]["id"].as_str().expect("thread id");

        let threads = call_tool(&server, "list_threads", json!({ "status": "open" }));
        let triage_body = format!(
            "# Triage\n\nOpen threads: {}\n",
            threads["threads"].as_array().expect("threads").len()
        );
        call_tool(
            &server,
            "create_markdown_file",
            json!({ "relativePath": "TRIAGE.md", "content": triage_body }),
        );
        call_tool(
            &server,
            "reply_thread",
            json!({
                "threadId": thread_id,
                "body": "I summarized this in TRIAGE.md.",
                "agentId": "acceptance",
                "authorName": "Acceptance Agent"
            }),
        );
        let proposal = call_tool(
            &server,
            "propose_thread_replacement",
            json!({
                "threadId": thread_id,
                "replacementText": "Concrete target sentence.",
                "summary": "Make the sentence more concrete"
            }),
        );
        let proposal_id = proposal["proposal"]["id"].as_str().expect("proposal id");
        call_tool(
            &server,
            "accept_proposal",
            json!({ "proposalId": proposal_id }),
        );

        let content = workspace::read_document_content(&root, "doc.md").expect("doc content");
        assert!(content.contains("Concrete target sentence."));
        assert!(root.join("TRIAGE.md").is_file());

        fs::remove_dir_all(root).expect("cleanup");
    }
}
