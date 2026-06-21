use std::path::{Path, PathBuf};

use margent_core::change_set::compute_unified_diff;
use margent_core::critic_markup::{parse_critic_markup, render_critic_markup};
use margent_core::proposal::ProposalRecord;
use margent_core::thread::AnchorRecord;
use serde::Serialize;

use crate::models::{DocumentRecord, ThreadRecord};
use crate::workspace;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCriticResult {
    pub document: DocumentRecord,
    pub output_path: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCriticResult {
    pub document: DocumentRecord,
    pub dry_run: bool,
    pub imported_threads: usize,
    pub imported_proposals: usize,
    pub warnings: Vec<String>,
    pub thread_ids: Vec<String>,
    pub proposal_ids: Vec<String>,
}

pub fn export_critic(
    root: &Path,
    document: &str,
    output_path: Option<&Path>,
    include_resolved: bool,
) -> Result<ExportCriticResult, String> {
    let document_record = workspace::resolve_document(root, Some(document))?;
    let content = workspace::read_document_content(root, &document_record.relative_path)?;
    let threads = workspace::load_threads_sorted(root, &document_record.id)?;
    let proposals = workspace::load_all_proposals(root)?
        .into_iter()
        .filter(|proposal| proposal.document_id == document_record.id)
        .collect::<Vec<_>>();
    let rendered = render_critic_markup(&content, &threads, &proposals, include_resolved);
    let output_path = output_path
        .map(PathBuf::from)
        .unwrap_or_else(|| default_critic_output_path(root, &document_record.relative_path));

    workspace::write_string_atomic(&output_path, &rendered.content)?;

    Ok(ExportCriticResult {
        document: document_record,
        output_path: output_path.to_string_lossy().to_string(),
        warnings: rendered.warnings,
    })
}

pub fn import_critic(
    root: &Path,
    critic_file: &Path,
    document: &str,
    dry_run: bool,
    author_name: &str,
) -> Result<ImportCriticResult, String> {
    let document_record = workspace::resolve_document(root, Some(document))?;
    let current_content = workspace::read_document_content(root, &document_record.relative_path)?;
    let marked_content = std::fs::read_to_string(critic_file)
        .map_err(|error| format!("Unable to read {}: {error}", critic_file.display()))?;
    let plan = parse_critic_markup(&marked_content);

    if plan.base_content != current_content {
        return Err(
            "The CriticMarkup base text does not match the current document. Re-export or import against the unchanged source document."
                .into(),
        );
    }

    let mut warnings = plan.warnings;
    let planned_threads = plan.comments.len();
    let planned_proposals = plan.replacements.len();

    if dry_run {
        return Ok(ImportCriticResult {
            document: document_record,
            dry_run,
            imported_threads: planned_threads,
            imported_proposals: planned_proposals,
            warnings,
            thread_ids: Vec::new(),
            proposal_ids: Vec::new(),
        });
    }

    let mut thread_ids = Vec::new();
    let mut proposal_ids = Vec::new();

    for comment in plan.comments {
        if comment.body.trim().is_empty() {
            warnings.push("Skipped an empty CriticMarkup comment.".into());
            continue;
        }
        let anchor = if comment.quote.is_empty() {
            document_anchor(&document_record, &current_content)
        } else {
            let occurrence =
                occurrence_for_range(&current_content, &comment.quote, comment.start_byte);
            workspace::build_anchor_from_quote(
                &document_record,
                &current_content,
                &comment.quote,
                occurrence,
            )?
        };
        let thread = workspace::create_thread(
            root,
            &document_record,
            &title_from_comment(&comment.body),
            &comment.body,
            anchor,
            "critic-import",
            "user",
            author_name,
            None,
        )?;
        thread_ids.push(thread.id);
    }

    for replacement in plan.replacements {
        let anchor = if replacement.old_text.is_empty() {
            document_anchor(&document_record, &current_content)
        } else {
            let occurrence = occurrence_for_range(
                &current_content,
                &replacement.old_text,
                replacement.start_byte,
            );
            workspace::build_anchor_from_quote(
                &document_record,
                &current_content,
                &replacement.old_text,
                occurrence,
            )?
        };
        let thread = workspace::create_thread(
            root,
            &document_record,
            "CriticMarkup suggestion",
            &critic_suggestion_body(&replacement.old_text, &replacement.new_text),
            anchor,
            "critic-import",
            "user",
            author_name,
            None,
        )?;
        let updated_document_text = replace_range(
            &current_content,
            replacement.start_byte,
            replacement.end_byte,
            &replacement.new_text,
        )?;
        let proposal = write_critic_proposal(
            root,
            &document_record,
            &current_content,
            &updated_document_text,
            &thread,
        )?;
        thread_ids.push(thread.id);
        proposal_ids.push(proposal.id);
    }

    Ok(ImportCriticResult {
        document: document_record,
        dry_run,
        imported_threads: thread_ids.len(),
        imported_proposals: proposal_ids.len(),
        warnings,
        thread_ids,
        proposal_ids,
    })
}

fn write_critic_proposal(
    root: &Path,
    document: &DocumentRecord,
    current_content: &str,
    updated_document_text: &str,
    thread: &ThreadRecord,
) -> Result<ProposalRecord, String> {
    let now = workspace::now_rfc3339()?;
    let proposal = ProposalRecord {
        schema_version: 1,
        id: workspace::next_id("proposal")?,
        document_id: document.id.clone(),
        thread_ids: vec![thread.id.clone()],
        adapter_id: "critic-import".into(),
        created_at: now.clone(),
        updated_at: now.clone(),
        status: "pending".into(),
        base_content_hash: document.current_content_hash.clone(),
        response_mode: "updated_document".into(),
        summary: "CriticMarkup imported suggestion".into(),
        assistant_message: "Imported from CriticMarkup substitution.".into(),
        updated_document_text: Some(updated_document_text.to_string()),
        unified_diff: None,
        computed_diff: compute_unified_diff(current_content, updated_document_text),
        warnings: Vec::new(),
        resolve_thread_ids: Vec::new(),
        stderr: None,
        error_message: None,
        extra: Default::default(),
    };

    workspace::save_proposal(root, &proposal)?;
    let mut thread = thread.clone();
    if !thread.linked_proposal_ids.contains(&proposal.id) {
        thread.linked_proposal_ids.push(proposal.id.clone());
        thread.updated_at = now;
        workspace::save_thread(root, &thread)?;
    }
    workspace::append_event(
        root,
        "proposal.received",
        Some(&thread.id),
        Some(&document.id),
        Some(&proposal.id),
        None,
    )?;

    Ok(proposal)
}

fn default_critic_output_path(root: &Path, relative_path: &str) -> PathBuf {
    let source = root.join(relative_path);
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.md");
    let output_name = if let Some(stem) = file_name.strip_suffix(".md") {
        format!("{stem}.critic.md")
    } else if let Some(stem) = file_name.strip_suffix(".markdown") {
        format!("{stem}.critic.markdown")
    } else {
        format!("{file_name}.critic.md")
    };
    source.with_file_name(output_name)
}

fn document_anchor(document: &DocumentRecord, content: &str) -> AnchorRecord {
    AnchorRecord {
        quote: format!("Entire document: {}", document.relative_path),
        prefix_context: String::new(),
        suffix_context: String::new(),
        start_offset_utf16: 0,
        end_offset_utf16: 0,
        start_line: 1,
        start_column: 1,
        end_line: 1,
        end_column: 1,
        heading_path: Vec::new(),
        block_fingerprint: String::new(),
        base_content_hash: workspace::content_hash(content),
        kind: "document".into(),
        footnote: None,
        state: "attached".into(),
        confidence: 1.0,
    }
}

fn occurrence_for_range(content: &str, quote: &str, start_byte: usize) -> usize {
    if quote.is_empty() {
        return 1;
    }
    content[..start_byte]
        .match_indices(quote)
        .count()
        .saturating_add(1)
}

fn replace_range(
    content: &str,
    start_byte: usize,
    end_byte: usize,
    replacement: &str,
) -> Result<String, String> {
    if start_byte > end_byte
        || end_byte > content.len()
        || !content.is_char_boundary(start_byte)
        || !content.is_char_boundary(end_byte)
    {
        return Err("CriticMarkup replacement range is not valid for the current document.".into());
    }
    let mut updated = String::new();
    updated.push_str(&content[..start_byte]);
    updated.push_str(replacement);
    updated.push_str(&content[end_byte..]);
    Ok(updated)
}

fn title_from_comment(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return "CriticMarkup comment".into();
    }
    truncate_title(&normalized)
}

fn critic_suggestion_body(old_text: &str, new_text: &str) -> String {
    if old_text.is_empty() {
        return format!("Imported CriticMarkup insertion:\n\n```markdown\n{new_text}\n```");
    }
    format!(
        "Imported CriticMarkup substitution.\n\nOld:\n```markdown\n{old_text}\n```\n\nNew:\n```markdown\n{new_text}\n```"
    )
}

fn truncate_title(value: &str) -> String {
    if value.chars().count() <= 72 {
        return value.to_string();
    }
    let truncated = value.chars().take(69).collect::<String>();
    format!("{truncated}...")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", workspace::next_id("test").unwrap()))
    }

    #[test]
    fn exports_and_imports_critic_markup_sidecars() {
        let root = unique_temp_dir("margent-critic");
        fs::create_dir_all(&root).expect("create root");
        workspace::ensure_workspace_layout(&root).expect("layout");
        fs::write(root.join("draft.md"), "A sentence. Old text.").expect("write document");
        let content = workspace::read_document_content(&root, "draft.md").expect("read document");
        let document =
            workspace::upsert_document_record(&root, "draft.md", &content).expect("index doc");
        let anchor =
            workspace::build_anchor_from_quote(&document, &content, "sentence", 1).expect("anchor");
        workspace::create_thread(
            &root,
            &document,
            "Sentence",
            "Needs a sharper noun.",
            anchor,
            "user",
            "user",
            "You",
            None,
        )
        .expect("thread");

        let export_result =
            export_critic(&root, "draft.md", None, false).expect("export critic markup");
        let exported = fs::read_to_string(&export_result.output_path).expect("read export");
        assert!(exported.contains("{==sentence==}{>>"));

        let marked_path = root.join("draft.import.md");
        fs::write(
            &marked_path,
            "A {==sentence==}{>>Needs work<<}. {~~Old text~>New text~~}.",
        )
        .expect("write marked");
        let import_result =
            import_critic(&root, &marked_path, "draft.md", false, "Reviewer").expect("import");

        assert_eq!(import_result.imported_threads, 2);
        assert_eq!(import_result.imported_proposals, 1);

        let proposals = workspace::load_all_proposals(&root).expect("load proposals");
        let imported = proposals
            .iter()
            .find(|proposal| proposal.adapter_id == "critic-import")
            .expect("critic proposal");
        assert_eq!(
            imported.updated_document_text.as_deref(),
            Some("A sentence. New text.")
        );

        fs::remove_dir_all(&root).expect("cleanup");
    }
}
