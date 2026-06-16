use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const MANUAL_RELATIVE_PATH: &str = ".mdreview/manual.md";
pub const MEMORY_RELATIVE_PATH: &str = ".mdreview/memory.md";
pub const REVIEW_SKILLS_RELATIVE_PATH: &str = ".mdreview/skills";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPassSummary {
    pub name: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPassRecord {
    pub name: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_pass: Option<ReviewPassRecord>,
}

pub fn list_review_passes(workspace_root: &Path) -> Result<Vec<ReviewPassSummary>, String> {
    let skills_dir = workspace_root.join(REVIEW_SKILLS_RELATIVE_PATH);
    if !skills_dir.exists() {
        return Ok(Vec::new());
    }

    let mut passes = Vec::new();
    for entry in fs::read_dir(&skills_dir)
        .map_err(|error| format!("Unable to read {}: {error}", skills_dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect review pass: {error}"))?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }

        let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        validate_review_pass_name(name)?;
        let body = fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
        passes.push(ReviewPassSummary {
            name: name.to_string(),
            title: review_pass_title(name, &body),
        });
    }

    passes.sort_by(|left, right| {
        left.title
            .cmp(&right.title)
            .then(left.name.cmp(&right.name))
    });
    Ok(passes)
}

pub fn load_review_context(
    workspace_root: &Path,
    pass_name: Option<&str>,
) -> Result<ReviewContext, String> {
    Ok(ReviewContext {
        manual: read_optional_trimmed(workspace_root.join(MANUAL_RELATIVE_PATH))?,
        memory: read_optional_trimmed(workspace_root.join(MEMORY_RELATIVE_PATH))?,
        review_pass: match pass_name.map(str::trim).filter(|value| !value.is_empty()) {
            Some(name) => Some(load_review_pass(workspace_root, name)?),
            None => None,
        },
    })
}

pub fn prepend_review_context(prompt: String, context: &ReviewContext) -> String {
    if context.manual.is_none() && context.memory.is_none() && context.review_pass.is_none() {
        return prompt;
    }

    let mut next = String::new();
    next.push_str("You have additional Margent workspace context. Follow it unless it conflicts with the immediate user request or the response contract.\n\n");

    if let Some(manual) = context.manual.as_deref() {
        next.push_str("## Workspace Manual\n\n");
        next.push_str(manual.trim());
        next.push_str("\n\n");
    }

    if let Some(memory) = context.memory.as_deref() {
        next.push_str("## Workspace Review Memory\n\n");
        next.push_str(memory.trim());
        next.push_str("\n\n");
    }

    if let Some(review_pass) = context.review_pass.as_ref() {
        next.push_str(&format!("## Review Pass: {}\n\n", review_pass.title));
        next.push_str(review_pass.body.trim());
        next.push_str("\n\n");
    }

    next.push_str("## Provider Request\n\n");
    next.push_str(&prompt);
    next
}

pub fn validate_review_pass_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Review pass name cannot be empty.".into());
    }
    if trimmed != name {
        return Err("Review pass name cannot include leading or trailing whitespace.".into());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(
            "Review pass names may contain only ASCII letters, numbers, hyphens, and underscores."
                .into(),
        );
    }
    Ok(())
}

fn load_review_pass(workspace_root: &Path, name: &str) -> Result<ReviewPassRecord, String> {
    validate_review_pass_name(name)?;
    let path = workspace_root
        .join(REVIEW_SKILLS_RELATIVE_PATH)
        .join(format!("{name}.md"));
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read review pass {}: {error}", path.display()))?;
    Ok(ReviewPassRecord {
        name: name.to_string(),
        title: review_pass_title(name, &body),
        body,
    })
}

fn read_optional_trimmed(path: PathBuf) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn review_pass_title(name: &str, body: &str) -> String {
    body.lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            name.split(['-', '_'])
                .filter(|part| !part.is_empty())
                .map(title_case_word)
                .collect::<Vec<_>>()
                .join(" ")
        })
}

fn title_case_word(word: &str) -> String {
    let mut characters = word.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    format!("{}{}", first.to_ascii_uppercase(), characters.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("margent-review-context-{label}-{nonce}"))
    }

    #[test]
    fn lists_direct_review_pass_files_only() {
        let root = unique_temp_dir("list");
        let skills = root.join(REVIEW_SKILLS_RELATIVE_PATH);
        fs::create_dir_all(skills.join("margent")).unwrap();
        fs::write(
            skills.join("fact-check.md"),
            "# Fact Check\n\nVerify claims.",
        )
        .unwrap();
        fs::write(skills.join("voice.md"), "Keep the author voice.").unwrap();
        fs::write(skills.join("margent").join("SKILL.md"), "tool docs").unwrap();

        let passes = list_review_passes(&root).unwrap();
        assert_eq!(
            passes,
            vec![
                ReviewPassSummary {
                    name: "fact-check".into(),
                    title: "Fact Check".into(),
                },
                ReviewPassSummary {
                    name: "voice".into(),
                    title: "Voice".into(),
                },
            ]
        );
    }

    #[test]
    fn prepends_available_context_sections() {
        let root = unique_temp_dir("context");
        fs::create_dir_all(root.join(REVIEW_SKILLS_RELATIVE_PATH)).unwrap();
        fs::write(root.join(MANUAL_RELATIVE_PATH), "Always preserve headings.").unwrap();
        fs::write(
            root.join(MEMORY_RELATIVE_PATH),
            "Prior reviewers disliked jargon.",
        )
        .unwrap();
        fs::write(
            root.join(REVIEW_SKILLS_RELATIVE_PATH).join("voice.md"),
            "# Voice\n\nSound like the reviewer.",
        )
        .unwrap();

        let context = load_review_context(&root, Some("voice")).unwrap();
        let prompt = prepend_review_context("Do the work.".into(), &context);
        assert!(prompt.contains("## Workspace Manual"));
        assert!(prompt.contains("## Workspace Review Memory"));
        assert!(prompt.contains("## Review Pass: Voice"));
        assert!(prompt.ends_with("Do the work."));
    }

    #[test]
    fn rejects_path_like_review_pass_names() {
        assert!(validate_review_pass_name("../voice").is_err());
        assert!(validate_review_pass_name("voice.md").is_err());
        assert!(validate_review_pass_name("voice pass").is_err());
    }
}
