pub mod export;
pub mod external;
pub mod proposal;
pub mod provider;
pub mod search;
pub mod thread;
pub mod workspace;

pub async fn run_blocking<T, F>(task_name: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Unable to join {task_name} task: {error}"))?
}
