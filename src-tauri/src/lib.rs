mod commands;
mod models;
mod services;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

const MENU_COMMAND_EVENT: &str = "margent://menu-command";
const MENU_CHECK_FOR_UPDATES: &str = "margent.check-for-updates";
const MENU_COMMAND_PALETTE: &str = "margent.command-palette";
const MENU_DELETE_ACTIVE_FILE: &str = "margent.delete-active-file";
const MENU_EXPORT_DOCX: &str = "margent.export-docx";
const MENU_EXPORT_GDOC: &str = "margent.export-gdoc";
const MENU_EXPORT_HTML: &str = "margent.export-html";
const MENU_EXPORT_PDF: &str = "margent.export-pdf";
const MENU_FIND: &str = "margent.find";
const MENU_NEW_FILE: &str = "margent.new-file";
const MENU_OPEN_FILE: &str = "margent.open-file";
const MENU_OPEN_RECENT: &str = "margent.open-recent";
const MENU_PROVIDERS: &str = "margent.providers";
const MENU_PROJECT_SEARCH: &str = "margent.project-search";
const MENU_QUICK_OPEN: &str = "margent.quick-open";
const MENU_RAW_MODE: &str = "margent.mode-raw";
const MENU_RENAME_ACTIVE_FILE: &str = "margent.rename-active-file";
const MENU_RENDERED_MODE: &str = "margent.mode-rendered";
const MENU_REVERT_LAST_SNAPSHOT: &str = "margent.revert-last-snapshot";
const MENU_REVEAL_ACTIVE_FILE: &str = "margent.reveal-active-file";
const MENU_REVIEW_BRIEF: &str = "margent.review-brief";
const MENU_SAVE: &str = "margent.save";
const MENU_TOGGLE_FOCUS_MODE: &str = "margent.toggle-focus-mode";
const MENU_TOGGLE_FILES: &str = "margent.toggle-files";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(services::open_request_service::PendingOpenRequestQueue::default())
        .manage(services::provider_service::ProviderRunRegistry::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            if let Some(urls) = app.deep_link().get_current()? {
                let queue =
                    app_handle.state::<services::open_request_service::PendingOpenRequestQueue>();
                services::open_request_service::queue_and_emit_open_request(
                    &app_handle,
                    &queue,
                    &urls,
                );
            }

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let queue =
                    app_handle.state::<services::open_request_service::PendingOpenRequestQueue>();
                let urls = event.urls();
                services::open_request_service::queue_and_emit_open_request(
                    &app_handle,
                    &queue,
                    &urls,
                );
            });

            Ok(())
        })
        .menu(build_app_menu)
        .on_menu_event(|app_handle, event| {
            let command = event.id().as_ref();
            if command.starts_with("margent.") {
                let _ = app_handle.emit(MENU_COMMAND_EVENT, command.to_string());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::open_workspace,
            commands::workspace::list_review_passes,
            commands::workspace::read_document,
            commands::workspace::create_markdown_file,
            commands::workspace::rename_markdown_file,
            commands::workspace::delete_markdown_file,
            commands::workspace::list_document_snapshots,
            commands::workspace::revert_latest_snapshot,
            commands::workspace::reveal_markdown_file,
            commands::workspace::check_document_update,
            commands::workspace::save_document,
            commands::workspace::save_document_if_current,
            commands::workspace::import_asset,
            commands::workspace::take_pending_open_requests,
            commands::export::export_document,
            commands::search::search_workspace,
            commands::thread::load_threads,
            commands::thread::load_all_threads,
            commands::thread::load_thread,
            commands::thread::check_thread_update_signature,
            commands::thread::create_thread,
            commands::thread::add_thread_message,
            commands::thread::delete_thread,
            commands::thread::resolve_thread,
            commands::thread::reopen_thread,
            commands::proposal::load_adapters,
            commands::proposal::save_adapters,
            commands::proposal::load_proposals,
            commands::proposal::load_all_proposals,
            commands::proposal::request_proposal,
            commands::proposal::get_proposal_change_set,
            commands::proposal::accept_proposal,
            commands::proposal::accept_proposal_hunks,
            commands::proposal::reject_proposal,
            commands::provider::get_provider_readiness,
            commands::provider::run_provider_thread_action,
            commands::provider::run_provider_document_action,
            commands::provider::run_codex_thread_action,
            commands::provider::cancel_provider_action,
            commands::external::open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Ready | tauri::RunEvent::Reopen { .. }
        ) {
            ensure_main_window(app_handle);
        }

        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            let queue =
                app_handle.state::<services::open_request_service::PendingOpenRequestQueue>();
            services::open_request_service::queue_and_emit_open_request(app_handle, &queue, &urls);
        }
    });
}

fn ensure_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // Anomalous path: macOS state restoration can produce a windowless launch
    // (AppKit restoring a bogus window); recreate the main window when it does.
    eprintln!("Margent window recovery: creating main window");
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Margent")
        .inner_size(1480.0, 960.0)
        .min_inner_size(1180.0, 760.0)
        .build()
    {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("failed to create Margent main window: {error}");
        }
    }
}

fn build_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quick_open = MenuItemBuilder::with_id(MENU_QUICK_OPEN, "Quick Open...")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let new_file = MenuItemBuilder::with_id(MENU_NEW_FILE, "New Markdown File")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_file = MenuItemBuilder::with_id(MENU_OPEN_FILE, "Open File...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_recent = MenuItemBuilder::with_id(MENU_OPEN_RECENT, "Open Recent...").build(app)?;
    let save = MenuItemBuilder::with_id(MENU_SAVE, "Save Draft")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let revert_last_snapshot =
        MenuItemBuilder::with_id(MENU_REVERT_LAST_SNAPSHOT, "Revert Last Snapshot").build(app)?;
    let rename_active_file =
        MenuItemBuilder::with_id(MENU_RENAME_ACTIVE_FILE, "Rename Active File...").build(app)?;
    let reveal_active_file =
        MenuItemBuilder::with_id(MENU_REVEAL_ACTIVE_FILE, "Reveal Active File").build(app)?;
    let delete_active_file =
        MenuItemBuilder::with_id(MENU_DELETE_ACTIVE_FILE, "Delete Active File").build(app)?;
    let export_html = MenuItemBuilder::with_id(MENU_EXPORT_HTML, "Export HTML").build(app)?;
    let export_docx = MenuItemBuilder::with_id(MENU_EXPORT_DOCX, "Export DOCX").build(app)?;
    let export_gdoc =
        MenuItemBuilder::with_id(MENU_EXPORT_GDOC, "Export to Google Docs").build(app)?;
    let export_pdf = MenuItemBuilder::with_id(MENU_EXPORT_PDF, "Print / Save as PDF").build(app)?;
    let find = MenuItemBuilder::with_id(MENU_FIND, "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let project_search = MenuItemBuilder::with_id(MENU_PROJECT_SEARCH, "Find in Workspace")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    let command_palette = MenuItemBuilder::with_id(MENU_COMMAND_PALETTE, "Command Palette...")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
    let rendered_mode = MenuItemBuilder::with_id(MENU_RENDERED_MODE, "Rendered Mode")
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    let raw_mode = MenuItemBuilder::with_id(MENU_RAW_MODE, "Raw Mode")
        .accelerator("CmdOrCtrl+2")
        .build(app)?;
    let toggle_files =
        MenuItemBuilder::with_id(MENU_TOGGLE_FILES, "Toggle File Pane").build(app)?;
    let toggle_focus_mode =
        MenuItemBuilder::with_id(MENU_TOGGLE_FOCUS_MODE, "Focus Mode").build(app)?;
    let providers = MenuItemBuilder::with_id(MENU_PROVIDERS, "Providers").build(app)?;
    let review_brief = MenuItemBuilder::with_id(MENU_REVIEW_BRIEF, "Review Brief").build(app)?;
    let check_for_updates =
        MenuItemBuilder::with_id(MENU_CHECK_FOR_UPDATES, "Check for Updates...").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Margent")
        .about(None)
        .separator()
        .item(&check_for_updates)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&quick_open)
        .item(&open_file)
        .item(&open_recent)
        .item(&save)
        .item(&revert_last_snapshot)
        .separator()
        .item(&rename_active_file)
        .item(&reveal_active_file)
        .item(&delete_active_file)
        .separator()
        .item(&export_html)
        .item(&export_docx)
        .item(&export_gdoc)
        .item(&export_pdf)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .item(&project_search)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&command_palette)
        .separator()
        .item(&review_brief)
        .item(&providers)
        .separator()
        .item(&rendered_mode)
        .item(&raw_mode)
        .item(&toggle_focus_mode)
        .separator()
        .item(&toggle_files)
        .fullscreen()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window").minimize().build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}
