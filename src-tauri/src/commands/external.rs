use std::process::Command;

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed_url = url.trim();
    let lower_url = trimmed_url.to_ascii_lowercase();

    if !(lower_url.starts_with("http://") || lower_url.starts_with("https://")) {
        return Err("Only http and https links can be opened.".into());
    }

    if trimmed_url.chars().any(char::is_control) {
        return Err("Link contains invalid control characters.".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed_url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(trimmed_url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed_url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open link: {error}"))
}
