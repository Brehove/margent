use serde::{Deserialize, Serialize};

pub use margent_core::document::{DocumentRecord, HeadingIndexEntry};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub schema_version: u8,
    pub id: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub display_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_content_hash: String,
    pub last_known_line_ending: String,
    pub frontmatter_mode: String,
    pub word_count: usize,
    pub heading_index: Vec<HeadingIndexEntry>,
    pub content: String,
}

pub trait IntoDocumentPayload {
    fn into_payload(self, absolute_path: String, content: String) -> DocumentPayload;
}

impl IntoDocumentPayload for DocumentRecord {
    fn into_payload(self, absolute_path: String, content: String) -> DocumentPayload {
        DocumentPayload {
            schema_version: self.schema_version,
            id: self.id,
            relative_path: self.relative_path,
            absolute_path,
            display_name: self.display_name,
            created_at: self.created_at,
            updated_at: self.updated_at,
            current_content_hash: self.current_content_hash,
            last_known_line_ending: self.last_known_line_ending,
            frontmatter_mode: self.frontmatter_mode,
            word_count: self.word_count,
            heading_index: self.heading_index,
            content,
        }
    }
}
