use crate::models::thread::{AnchorRecord, ThreadRecord};
use crate::services::thread_service;

#[tauri::command]
pub fn load_threads(
    workspace_root: String,
    document_id: String,
) -> Result<Vec<ThreadRecord>, String> {
    thread_service::load_threads(&workspace_root, &document_id)
}

#[tauri::command]
pub fn load_all_threads(workspace_root: String) -> Result<Vec<ThreadRecord>, String> {
    thread_service::load_all_threads(&workspace_root)
}

#[tauri::command]
pub fn load_thread(workspace_root: String, thread_id: String) -> Result<ThreadRecord, String> {
    thread_service::load_thread(&workspace_root, &thread_id)
}

#[tauri::command]
pub fn check_thread_update_signature(
    workspace_root: String,
    document_id: String,
) -> Result<String, String> {
    thread_service::thread_update_signature(&workspace_root, &document_id)
}

#[tauri::command]
pub fn create_thread(
    workspace_root: String,
    document_id: String,
    title: String,
    body: String,
    anchor: AnchorRecord,
) -> Result<ThreadRecord, String> {
    thread_service::create_thread(&workspace_root, &document_id, &title, &body, anchor)
}

#[tauri::command]
pub fn add_thread_message(
    workspace_root: String,
    thread_id: String,
    body: String,
    kind: String,
) -> Result<ThreadRecord, String> {
    thread_service::add_thread_message(&workspace_root, &thread_id, &body, &kind)
}

#[tauri::command]
pub fn delete_thread(workspace_root: String, thread_id: String) -> Result<ThreadRecord, String> {
    thread_service::delete_thread(&workspace_root, &thread_id)
}

#[tauri::command]
pub fn resolve_thread(workspace_root: String, thread_id: String) -> Result<ThreadRecord, String> {
    thread_service::resolve_thread(&workspace_root, &thread_id)
}

#[tauri::command]
pub fn reopen_thread(workspace_root: String, thread_id: String) -> Result<ThreadRecord, String> {
    thread_service::reopen_thread(&workspace_root, &thread_id)
}
