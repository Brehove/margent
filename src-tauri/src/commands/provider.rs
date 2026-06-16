use crate::models::provider::{
    ProviderDocumentAction, ProviderThreadAction, ProviderThreadActionResult, ThreadProvider,
};
use crate::services::provider_service;
use margent_core::provider_readiness::{inspect_providers, ProviderReadiness};
use tauri::{Emitter, State};

#[tauri::command]
pub async fn get_provider_readiness() -> Result<Vec<ProviderReadiness>, String> {
    tauri::async_runtime::spawn_blocking(inspect_providers)
        .await
        .map_err(|error| format!("Unable to join provider readiness task: {error}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_provider_thread_action(
    app: tauri::AppHandle,
    registry: State<'_, provider_service::ProviderRunRegistry>,
    workspace_root: String,
    document_id: String,
    document_relative_path: Option<String>,
    thread_id: String,
    provider: ThreadProvider,
    action: ProviderThreadAction,
    instruction: String,
    pass_name: Option<String>,
    run_id: Option<String>,
) -> Result<ProviderThreadActionResult, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let run_context = run_id.map(|run_id| provider_service::ProviderRunContext {
            run_id,
            workspace_root: workspace_root.clone(),
            thread_id: Some(thread_id.clone()),
        });
        provider_service::run_provider_thread_action_with_stream(
            &workspace_root,
            &document_id,
            document_relative_path.as_deref(),
            &thread_id,
            provider,
            action,
            &instruction,
            pass_name.as_deref(),
            run_context,
            Some(&registry),
            &mut |event| {
                let _ = app.emit(provider_service::PROVIDER_STREAM_EVENT, event);
            },
        )
    })
    .await
    .map_err(|error| format!("Unable to join provider task: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_provider_document_action(
    app: tauri::AppHandle,
    registry: State<'_, provider_service::ProviderRunRegistry>,
    workspace_root: String,
    document_id: String,
    document_relative_path: Option<String>,
    provider: ThreadProvider,
    action: ProviderDocumentAction,
    instruction: String,
    pass_name: Option<String>,
    run_id: Option<String>,
) -> Result<ProviderThreadActionResult, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let run_context = run_id.map(|run_id| provider_service::ProviderRunContext {
            run_id,
            workspace_root: workspace_root.clone(),
            thread_id: None,
        });
        provider_service::run_provider_document_action_with_stream(
            &workspace_root,
            &document_id,
            document_relative_path.as_deref(),
            provider,
            action,
            &instruction,
            pass_name.as_deref(),
            run_context,
            Some(&registry),
            &mut |event| {
                let _ = app.emit(provider_service::PROVIDER_STREAM_EVENT, event);
            },
        )
    })
    .await
    .map_err(|error| format!("Unable to join document provider task: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_codex_thread_action(
    app: tauri::AppHandle,
    registry: State<'_, provider_service::ProviderRunRegistry>,
    workspace_root: String,
    document_id: String,
    document_relative_path: Option<String>,
    thread_id: String,
    action: ProviderThreadAction,
    instruction: String,
    pass_name: Option<String>,
    run_id: Option<String>,
) -> Result<ProviderThreadActionResult, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let run_context = run_id.map(|run_id| provider_service::ProviderRunContext {
            run_id,
            workspace_root: workspace_root.clone(),
            thread_id: Some(thread_id.clone()),
        });
        provider_service::run_provider_thread_action_with_stream(
            &workspace_root,
            &document_id,
            document_relative_path.as_deref(),
            &thread_id,
            ThreadProvider::Codex,
            action,
            &instruction,
            pass_name.as_deref(),
            run_context,
            Some(&registry),
            &mut |event| {
                let _ = app.emit(provider_service::PROVIDER_STREAM_EVENT, event);
            },
        )
    })
    .await
    .map_err(|error| format!("Unable to join Codex task: {error}"))?
}

#[tauri::command]
pub async fn cancel_provider_action(
    registry: State<'_, provider_service::ProviderRunRegistry>,
    run_id: String,
) -> Result<(), String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        provider_service::cancel_provider_run(&registry, &run_id)
    })
    .await
    .map_err(|error| format!("Unable to join provider cancel task: {error}"))?
}
