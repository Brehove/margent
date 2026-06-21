use crate::models::adapter::AdapterDefinition;
use crate::models::document::DocumentVersion;
use crate::models::proposal::{
    ProposalChangeSetResult, ProposalHunkAcceptResult, ProposalMutationResult, ProposalRecord,
};
use crate::services::{adapter_service, proposal_service};

#[tauri::command]
pub async fn load_adapters(workspace_root: String) -> Result<Vec<AdapterDefinition>, String> {
    super::run_blocking("load adapters", move || {
        adapter_service::load_adapters(&workspace_root)
    })
    .await
}

#[tauri::command]
pub async fn save_adapters(
    workspace_root: String,
    adapters: Vec<AdapterDefinition>,
) -> Result<Vec<AdapterDefinition>, String> {
    super::run_blocking("save adapters", move || {
        adapter_service::save_adapters(&workspace_root, adapters)
    })
    .await
}

#[tauri::command]
pub async fn load_proposals(
    workspace_root: String,
    document_id: String,
) -> Result<Vec<ProposalRecord>, String> {
    super::run_blocking("load proposals", move || {
        proposal_service::load_proposals(&workspace_root, &document_id)
    })
    .await
}

#[tauri::command]
pub async fn load_all_proposals(workspace_root: String) -> Result<Vec<ProposalRecord>, String> {
    super::run_blocking("load all proposals", move || {
        proposal_service::load_all_proposals(&workspace_root)
    })
    .await
}

#[tauri::command]
pub async fn request_proposal(
    workspace_root: String,
    document_id: String,
    thread_id: String,
    adapter_id: String,
    instructions: String,
) -> Result<ProposalRecord, String> {
    super::run_blocking("request proposal", move || {
        proposal_service::request_proposal(
            &workspace_root,
            &document_id,
            &thread_id,
            &adapter_id,
            &instructions,
        )
    })
    .await
}

#[tauri::command]
pub async fn get_proposal_change_set(
    workspace_root: String,
    proposal_id: String,
) -> Result<ProposalChangeSetResult, String> {
    super::run_blocking("get proposal change set", move || {
        proposal_service::get_proposal_change_set(&workspace_root, &proposal_id)
    })
    .await
}

#[tauri::command]
pub async fn accept_proposal(
    workspace_root: String,
    proposal_id: String,
    updated_document_text: Option<String>,
) -> Result<ProposalMutationResult, String> {
    super::run_blocking("accept proposal", move || {
        proposal_service::accept_proposal(&workspace_root, &proposal_id, updated_document_text)
    })
    .await
}

#[tauri::command]
pub async fn accept_proposal_hunks(
    workspace_root: String,
    proposal_id: String,
    selected_hunk_ids: Vec<String>,
    expected_document_version: DocumentVersion,
) -> Result<ProposalHunkAcceptResult, String> {
    super::run_blocking("accept proposal hunks", move || {
        proposal_service::accept_proposal_hunks(
            &workspace_root,
            &proposal_id,
            selected_hunk_ids,
            &expected_document_version,
        )
    })
    .await
}

#[tauri::command]
pub async fn reject_proposal(
    workspace_root: String,
    proposal_id: String,
) -> Result<ProposalMutationResult, String> {
    super::run_blocking("reject proposal", move || {
        proposal_service::reject_proposal(&workspace_root, &proposal_id)
    })
    .await
}
