use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime, Url};

use crate::models::workspace::WorkspaceOpenRequest;

pub const OPEN_REQUEST_EVENT: &str = "margent://open-request";

#[derive(Default)]
pub struct PendingOpenRequestQueue {
    next_id: AtomicU64,
    queue: Mutex<Vec<WorkspaceOpenRequest>>,
}

impl PendingOpenRequestQueue {
    pub fn push_path(&self, path: String) -> WorkspaceOpenRequest {
        self.push_request(WorkspaceOpenRequest {
            id: 0,
            path,
            document_relative_path: None,
            thread_id: None,
            workspace_root: None,
        })
    }

    pub fn push_deep_link(
        &self,
        workspace_root: Option<String>,
        document_relative_path: String,
        thread_id: Option<String>,
    ) -> WorkspaceOpenRequest {
        let path = workspace_root
            .as_deref()
            .map(|root| {
                Path::new(root)
                    .join(&document_relative_path)
                    .to_string_lossy()
                    .to_string()
            })
            .unwrap_or_else(|| document_relative_path.clone());

        self.push_request(WorkspaceOpenRequest {
            id: 0,
            path,
            document_relative_path: Some(document_relative_path),
            thread_id,
            workspace_root,
        })
    }

    fn push_request(&self, mut request: WorkspaceOpenRequest) -> WorkspaceOpenRequest {
        request.id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.push(request.clone());
        request
    }

    pub fn take_all(&self) -> Vec<WorkspaceOpenRequest> {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *queue)
    }
}

pub fn queue_and_emit_open_request<R: Runtime>(
    app: &AppHandle<R>,
    queue: &PendingOpenRequestQueue,
    urls: &[Url],
) {
    let Some(request) = urls
        .iter()
        .find_map(|url| open_request_from_url(queue, url))
    else {
        return;
    };

    let _ = app.emit(OPEN_REQUEST_EVENT, &request);
}

fn open_request_from_url(
    queue: &PendingOpenRequestQueue,
    url: &Url,
) -> Option<WorkspaceOpenRequest> {
    deep_link_request_from_url(queue, url)
        .or_else(|| file_path_from_url(url).map(|path| queue.push_path(path)))
}

fn deep_link_request_from_url(
    queue: &PendingOpenRequestQueue,
    url: &Url,
) -> Option<WorkspaceOpenRequest> {
    if url.scheme() != margent_core::deep_link::MARGENT_DEEP_LINK_SCHEME {
        return None;
    }

    let is_open_link = url.host_str() == Some("open") || url.path().trim_matches('/') == "open";
    if !is_open_link {
        return None;
    }

    let mut document_relative_path = None;
    let mut thread_id = None;
    let mut workspace_root = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "doc" => document_relative_path = Some(value.into_owned()),
            "thread" => thread_id = non_empty(value.as_ref()),
            "workspace" | "root" => workspace_root = non_empty(value.as_ref()),
            _ => {}
        }
    }

    let document_relative_path = document_relative_path?;
    if !is_safe_workspace_relative_path(&document_relative_path) {
        return None;
    }

    Some(queue.push_deep_link(workspace_root, document_relative_path, thread_id))
}

fn file_path_from_url(url: &Url) -> Option<String> {
    url.to_file_path()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

fn is_safe_workspace_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('~')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{deep_link_request_from_url, PendingOpenRequestQueue};
    use tauri::Url;

    #[test]
    fn take_all_drains_queued_requests() {
        let queue = PendingOpenRequestQueue::default();
        let first = queue.push_path("/tmp/first.md".into());
        let second = queue.push_path("/tmp/second.md".into());

        let pending = queue.take_all();

        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].id, first.id);
        assert_eq!(pending[1].id, second.id);
        assert!(queue.take_all().is_empty());
    }

    #[test]
    fn parses_margent_open_deep_link() {
        let queue = PendingOpenRequestQueue::default();
        let url = Url::parse(
            "margent://open?workspace=%2FUsers%2Fexample%2Fworkspace&doc=drafts%2Fone.md&thread=thread-1",
        )
        .expect("valid url");

        let request = deep_link_request_from_url(&queue, &url).expect("deep link request");

        assert_eq!(
            request.document_relative_path.as_deref(),
            Some("drafts/one.md")
        );
        assert_eq!(request.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            request.workspace_root.as_deref(),
            Some("/Users/example/workspace")
        );
        assert!(request.path.ends_with("drafts/one.md"));
    }

    #[test]
    fn rejects_unsafe_deep_link_document_paths() {
        let queue = PendingOpenRequestQueue::default();
        let url =
            Url::parse("margent://open?doc=..%2Fsecret.md&thread=thread-1").expect("valid url");

        assert!(deep_link_request_from_url(&queue, &url).is_none());
        assert!(queue.take_all().is_empty());
    }
}
