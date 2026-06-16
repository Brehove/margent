use crate::models::adapter::AdapterDefinition;
use crate::models::proposal::{ProposalMutationResult, ProposalRecord};
use crate::services::{adapter_service, proposal_service};

#[tauri::command]
pub fn load_adapters(workspace_root: String) -> Result<Vec<AdapterDefinition>, String> {
    adapter_service::load_adapters(&workspace_root)
}

#[tauri::command]
pub fn save_adapters(
    workspace_root: String,
    adapters: Vec<AdapterDefinition>,
) -> Result<Vec<AdapterDefinition>, String> {
    adapter_service::save_adapters(&workspace_root, adapters)
}

#[tauri::command]
pub fn load_proposals(
    workspace_root: String,
    document_id: String,
) -> Result<Vec<ProposalRecord>, String> {
    proposal_service::load_proposals(&workspace_root, &document_id)
}

#[tauri::command]
pub fn load_all_proposals(workspace_root: String) -> Result<Vec<ProposalRecord>, String> {
    proposal_service::load_all_proposals(&workspace_root)
}

#[tauri::command]
pub fn request_proposal(
    workspace_root: String,
    document_id: String,
    thread_id: String,
    adapter_id: String,
    instructions: String,
) -> Result<ProposalRecord, String> {
    proposal_service::request_proposal(
        &workspace_root,
        &document_id,
        &thread_id,
        &adapter_id,
        &instructions,
    )
}

#[tauri::command]
pub fn accept_proposal(
    workspace_root: String,
    proposal_id: String,
    updated_document_text: Option<String>,
) -> Result<ProposalMutationResult, String> {
    proposal_service::accept_proposal(&workspace_root, &proposal_id, updated_document_text)
}

#[tauri::command]
pub fn reject_proposal(
    workspace_root: String,
    proposal_id: String,
) -> Result<ProposalMutationResult, String> {
    proposal_service::reject_proposal(&workspace_root, &proposal_id)
}
