use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingIndexEntry {
    pub depth: u8,
    pub text: String,
    pub line: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub schema_version: u8,
    pub id: String,
    pub relative_path: String,
    pub display_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_content_hash: String,
    pub last_known_line_ending: String,
    pub frontmatter_mode: String,
    pub word_count: usize,
    pub heading_index: Vec<HeadingIndexEntry>,
}

pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub fn extract_heading_index(content: &str) -> Vec<HeadingIndexEntry> {
    content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim_start();
            let depth = trimmed
                .chars()
                .take_while(|character| *character == '#')
                .count();

            if !(1..=6).contains(&depth) {
                return None;
            }

            let rest = trimmed[depth..].trim_start();
            if rest.is_empty() {
                return None;
            }

            Some(HeadingIndexEntry {
                depth: depth as u8,
                text: rest.to_string(),
                line: index + 1,
            })
        })
        .collect()
}
