use crate::models::thread::{AnchorRecord, ThreadRecord};
use crate::services::thread_service;

#[tauri::command]
pub async fn load_threads(
    workspace_root: String,
    document_id: String,
) -> Result<Vec<ThreadRecord>, String> {
    super::run_blocking("load threads", move || {
        thread_service::load_threads(&workspace_root, &document_id)
    })
    .await
}

#[tauri::command]
pub async fn load_all_threads(workspace_root: String) -> Result<Vec<ThreadRecord>, String> {
    super::run_blocking("load all threads", move || {
        thread_service::load_all_threads(&workspace_root)
    })
    .await
}

#[tauri::command]
pub async fn load_thread(
    workspace_root: String,
    thread_id: String,
) -> Result<ThreadRecord, String> {
    super::run_blocking("load thread", move || {
        thread_service::load_thread(&workspace_root, &thread_id)
    })
    .await
}

#[tauri::command]
pub async fn check_thread_update_signature(
    workspace_root: String,
    document_id: String,
) -> Result<String, String> {
    super::run_blocking("check thread update signature", move || {
        thread_service::thread_update_signature(&workspace_root, &document_id)
    })
    .await
}

#[tauri::command]
pub async fn create_thread(
    workspace_root: String,
    document_id: String,
    title: String,
    body: String,
    anchor: AnchorRecord,
) -> Result<ThreadRecord, String> {
    super::run_blocking("create thread", move || {
        thread_service::create_thread(&workspace_root, &document_id, &title, &body, anchor)
    })
    .await
}

#[tauri::command]
pub async fn add_thread_message(
    workspace_root: String,
    thread_id: String,
    body: String,
    kind: String,
) -> Result<ThreadRecord, String> {
    super::run_blocking("add thread message", move || {
        thread_service::add_thread_message(&workspace_root, &thread_id, &body, &kind)
    })
    .await
}

#[tauri::command]
pub async fn delete_thread(
    workspace_root: String,
    thread_id: String,
) -> Result<ThreadRecord, String> {
    super::run_blocking("delete thread", move || {
        thread_service::delete_thread(&workspace_root, &thread_id)
    })
    .await
}

#[tauri::command]
pub async fn resolve_thread(
    workspace_root: String,
    thread_id: String,
) -> Result<ThreadRecord, String> {
    super::run_blocking("resolve thread", move || {
        thread_service::resolve_thread(&workspace_root, &thread_id)
    })
    .await
}

#[tauri::command]
pub async fn reopen_thread(
    workspace_root: String,
    thread_id: String,
) -> Result<ThreadRecord, String> {
    super::run_blocking("reopen thread", move || {
        thread_service::reopen_thread(&workspace_root, &thread_id)
    })
    .await
}
