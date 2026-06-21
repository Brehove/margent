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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub content_hash: String,
    #[serde(default, with = "optional_u128_string")]
    pub modified_ns: Option<u128>,
    pub size: u64,
}

mod optional_u128_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &Option<u128>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u128>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(|value| value.parse::<u128>().map_err(serde::de::Error::custom))
            .transpose()
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_version_round_trips_modified_ns_as_a_string() {
        let version = DocumentVersion {
            content_hash: "sha256:test".into(),
            modified_ns: Some(12_345_678_901_234_567_890),
            size: 42,
        };

        let value = serde_json::to_value(&version).expect("serialize version");
        assert_eq!(value["modifiedNs"], "12345678901234567890");

        let decoded: DocumentVersion = serde_json::from_value(value).expect("deserialize version");
        assert_eq!(decoded, version);
    }
}
