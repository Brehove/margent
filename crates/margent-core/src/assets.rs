use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Debug)]
pub struct MarkdownAssetDocument<'a> {
    pub relative_path: &'a str,
    pub content: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    pub document_path: String,
    pub line: usize,
    pub source: String,
    pub asset_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFile {
    pub relative_path: String,
    pub referenced: bool,
    pub reference_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetScanReport {
    pub assets_dir: String,
    pub assets: Vec<AssetFile>,
    pub references: Vec<AssetReference>,
    pub orphaned_assets: Vec<String>,
    pub missing_assets: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MarkdownImage {
    pub(crate) alt: String,
    pub(crate) destination: String,
    pub(crate) title: Option<String>,
    pub(crate) attributes: ImageAttributes,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ImageAttributes {
    pub(crate) id: Option<String>,
    pub(crate) classes: Vec<String>,
    pub(crate) key_values: Vec<(String, String)>,
}

impl ImageAttributes {
    pub(crate) fn is_empty(&self) -> bool {
        self.id.is_none() && self.classes.is_empty() && self.key_values.is_empty()
    }

    pub(crate) fn value(&self, key: &str) -> Option<&str> {
        self.key_values
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
}

pub fn scan_workspace_assets(
    root: &Path,
    documents: &[MarkdownAssetDocument<'_>],
) -> Result<AssetScanReport, String> {
    let asset_paths = list_asset_files(root)?;
    let asset_set: BTreeSet<_> = asset_paths.iter().cloned().collect();
    let mut references = Vec::new();

    for document in documents {
        references.extend(scan_document_asset_references(
            document.relative_path,
            document.content,
        ));
    }
    references.sort_by(|left, right| {
        left.asset_path
            .cmp(&right.asset_path)
            .then_with(|| left.document_path.cmp(&right.document_path))
            .then_with(|| left.line.cmp(&right.line))
            .then_with(|| left.source.cmp(&right.source))
    });

    let mut reference_counts = BTreeMap::<String, usize>::new();
    for reference in &references {
        *reference_counts
            .entry(reference.asset_path.clone())
            .or_insert(0) += 1;
    }

    let assets = asset_paths
        .iter()
        .map(|relative_path| {
            let reference_count = reference_counts.get(relative_path).copied().unwrap_or(0);
            AssetFile {
                relative_path: relative_path.clone(),
                referenced: reference_count > 0,
                reference_count,
            }
        })
        .collect::<Vec<_>>();
    let orphaned_assets = assets
        .iter()
        .filter(|asset| !asset.referenced)
        .map(|asset| asset.relative_path.clone())
        .collect::<Vec<_>>();
    let missing_assets = reference_counts
        .keys()
        .filter(|asset_path| !asset_set.contains(*asset_path))
        .cloned()
        .collect::<Vec<_>>();

    Ok(AssetScanReport {
        assets_dir: "assets".into(),
        assets,
        references,
        orphaned_assets,
        missing_assets,
    })
}

pub fn scan_document_asset_references(document_path: &str, content: &str) -> Vec<AssetReference> {
    let mut references = Vec::new();

    for (line_index, line) in content.lines().enumerate() {
        let mut cursor = 0;
        while let Some(relative_start) = line[cursor..].find("![") {
            let start = cursor + relative_start;
            if is_escaped_at(line, start) {
                cursor = (start + 2).min(line.len());
                continue;
            }

            let Some((image, end)) = parse_inline_image_at(line, start) else {
                cursor = (start + 2).min(line.len());
                continue;
            };
            if let Some(asset_path) = resolve_asset_path(document_path, &image.destination) {
                references.push(AssetReference {
                    document_path: document_path.to_string(),
                    line: line_index + 1,
                    source: image.destination,
                    asset_path,
                });
            }
            cursor = end.max(start + 2).min(line.len());
        }
    }

    references
}

pub(crate) fn parse_standalone_attributed_image_line(line: &str) -> Option<MarkdownImage> {
    let trimmed = line.trim();
    let (image, end) = parse_inline_image_at(trimmed, 0)?;
    if image.attributes.is_empty() || !trimmed[end..].trim().is_empty() {
        return None;
    }
    Some(image)
}

fn list_asset_files(root: &Path) -> Result<Vec<String>, String> {
    let assets_root = root.join("assets");
    let mut paths = Vec::new();
    if !assets_root.exists() {
        return Ok(paths);
    }
    collect_asset_files(&assets_root, &assets_root, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn collect_asset_files(root: &Path, current: &Path, paths: &mut Vec<String>) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| {
            format!(
                "Unable to read asset directory {}: {error}",
                current.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Unable to read asset directory {}: {error}",
                current.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?;
        if file_type.is_dir() {
            collect_asset_files(root, &path, paths)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| format!("Unable to derive asset relative path: {error}"))?;
            let relative = slash_path(relative)
                .ok_or_else(|| format!("Unable to encode asset path {}", path.display()))?;
            paths.push(format!("assets/{relative}"));
        }
    }
    Ok(())
}

fn resolve_asset_path(document_path: &str, destination: &str) -> Option<String> {
    let destination = strip_query_or_fragment(destination.trim());
    if destination.is_empty()
        || destination.starts_with('/')
        || destination.starts_with('\\')
        || destination.starts_with("//")
        || destination.contains("://")
        || destination.starts_with("data:")
        || destination.starts_with('#')
    {
        return None;
    }

    let mut joined = PathBuf::new();
    if let Some(parent) = Path::new(document_path).parent() {
        joined.push(parent);
    }
    joined.push(destination);
    let normalized = normalize_workspace_relative_path(&joined)?;
    (normalized.starts_with("assets/") && normalized.len() > "assets/".len()).then_some(normalized)
}

fn strip_query_or_fragment(destination: &str) -> &str {
    destination.split(['?', '#']).next().unwrap_or(destination)
}

fn normalize_workspace_relative_path(path: &Path) -> Option<String> {
    let mut parts = Vec::<String>::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn slash_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(parts.join("/"))
}

fn parse_inline_image_at(input: &str, start: usize) -> Option<(MarkdownImage, usize)> {
    if !input[start..].starts_with("![") {
        return None;
    }

    let label_start = start + 2;
    let label_end = find_unescaped_byte(input, label_start, b']')?;
    if !input[label_end + 1..].starts_with('(') {
        return None;
    }

    let destination_start = label_end + 2;
    let destination_end = find_markdown_link_close(input, destination_start)?;
    let (destination, title) = parse_link_destination(&input[destination_start..destination_end])?;
    let mut end = destination_end + 1;
    let mut attributes = ImageAttributes::default();
    let attribute_start = skip_ascii_whitespace(input, end);
    if input[attribute_start..].starts_with('{') {
        if let Some((parsed, attribute_end)) = parse_attribute_block(&input[attribute_start..]) {
            attributes = parsed;
            end = attribute_start + attribute_end;
        }
    }

    Some((
        MarkdownImage {
            alt: unescape_markdown_text(&input[label_start..label_end]),
            destination,
            title,
            attributes,
        },
        end,
    ))
}

fn parse_link_destination(inner: &str) -> Option<(String, Option<String>)> {
    let trimmed = inner.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (destination, rest) = if let Some(stripped) = trimmed.strip_prefix('<') {
        let end = find_unescaped_byte(stripped, 0, b'>')?;
        (&stripped[..end], stripped[end + 1..].trim())
    } else {
        let split = first_ascii_whitespace(trimmed).unwrap_or(trimmed.len());
        (&trimmed[..split], trimmed[split..].trim())
    };

    if destination.is_empty() {
        return None;
    }
    Some((unescape_markdown_text(destination), parse_link_title(rest)))
}

fn parse_link_title(rest: &str) -> Option<String> {
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let bytes = rest.as_bytes();
    let opener = bytes[0];
    let closer = match opener {
        b'"' => b'"',
        b'\'' => b'\'',
        b'(' => b')',
        _ => return None,
    };
    let end = find_unescaped_byte(rest, 1, closer)?;
    Some(unescape_markdown_text(&rest[1..end]))
}

fn parse_attribute_block(input: &str) -> Option<(ImageAttributes, usize)> {
    if !input.starts_with('{') {
        return None;
    }
    let end = find_unescaped_byte(input, 1, b'}')?;
    let body = &input[1..end];
    let mut attributes = ImageAttributes::default();

    for token in attribute_tokens(body) {
        if let Some(id) = token.strip_prefix('#').filter(|id| !id.is_empty()) {
            attributes.id = Some(id.to_string());
        } else if let Some(class) = token.strip_prefix('.').filter(|class| !class.is_empty()) {
            attributes.classes.push(class.to_string());
        } else if let Some((key, value)) = token.split_once('=') {
            let key = key.trim();
            if key.is_empty() {
                continue;
            }
            attributes.key_values.push((
                key.to_string(),
                strip_wrapping_quotes(value.trim()).to_string(),
            ));
        }
    }

    Some((attributes, end + 1))
}

fn attribute_tokens(input: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut token_start = None;
    let mut quote = None;
    let mut escaped = false;

    for (index, character) in input.char_indices() {
        if token_start.is_none() {
            if character.is_whitespace() {
                continue;
            }
            token_start = Some(index);
        }

        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(quote_character) = quote {
            if character == quote_character {
                quote = None;
            }
            continue;
        }
        if matches!(character, '"' | '\'') {
            quote = Some(character);
            continue;
        }
        if character.is_whitespace() {
            if let Some(start) = token_start.take() {
                tokens.push(&input[start..index]);
            }
        }
    }

    if let Some(start) = token_start {
        tokens.push(&input[start..]);
    }

    tokens
}

fn strip_wrapping_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn first_ascii_whitespace(input: &str) -> Option<usize> {
    input
        .as_bytes()
        .iter()
        .position(|byte| byte.is_ascii_whitespace())
}

fn skip_ascii_whitespace(input: &str, start: usize) -> usize {
    let mut index = start;
    for byte in &input.as_bytes()[start..] {
        if !byte.is_ascii_whitespace() {
            break;
        }
        index += 1;
    }
    index
}

fn find_unescaped_byte(input: &str, start: usize, target: u8) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut index = start;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == target {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn find_markdown_link_close(input: &str, start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut index = start;
    let mut quote = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if let Some(quote_byte) = quote {
            if byte == quote_byte {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'"' | b'\'') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b')' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn is_escaped_at(input: &str, index: usize) -> bool {
    let bytes = input.as_bytes();
    let mut backslashes = 0usize;
    let mut cursor = index;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        backslashes += 1;
        cursor -= 1;
    }
    backslashes % 2 == 1
}

fn unescape_markdown_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut escaped = false;
    for character in input.chars() {
        if escaped {
            output.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            output.push(character);
        }
    }
    if escaped {
        output.push('\\');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("margent-core-assets-{label}-{nonce}"))
    }

    #[test]
    fn scans_asset_references_and_marks_orphans() {
        let root = temp_root("scan");
        fs::create_dir_all(root.join("assets/nested")).expect("assets");
        fs::write(root.join("assets/used.png"), b"used").expect("used asset");
        fs::write(root.join("assets/orphan.png"), b"orphan").expect("orphan asset");
        fs::write(root.join("assets/nested/used.jpg"), b"nested").expect("nested asset");

        let documents = [
            MarkdownAssetDocument {
                relative_path: "draft.md",
                content:
                    "![Used](assets/used.png){width=480px}\n![Remote](https://example.com/x.png)\n",
            },
            MarkdownAssetDocument {
                relative_path: "docs/chapter.md",
                content:
                    "![Nested](../assets/nested/used.jpg)\n![Missing](../assets/missing.png)\n",
            },
        ];
        let report = scan_workspace_assets(&root, &documents).expect("scan assets");

        assert_eq!(report.assets.len(), 3);
        assert_eq!(report.orphaned_assets, vec!["assets/orphan.png"]);
        assert_eq!(report.missing_assets, vec!["assets/missing.png"]);
        assert!(report
            .references
            .iter()
            .any(|reference| reference.asset_path == "assets/used.png" && reference.line == 1));
        assert!(report
            .assets
            .iter()
            .any(|asset| asset.relative_path == "assets/nested/used.jpg" && asset.referenced));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn parses_standalone_attributed_image_lines_conservatively() {
        let image = parse_standalone_attributed_image_line(
            r#"  ![Alt](assets/pic.png "Caption"){#hero .wide width=480px}  "#,
        )
        .expect("parse attributed image");

        assert_eq!(image.alt, "Alt");
        assert_eq!(image.destination, "assets/pic.png");
        assert_eq!(image.title.as_deref(), Some("Caption"));
        assert_eq!(image.attributes.id.as_deref(), Some("hero"));
        assert_eq!(image.attributes.classes, vec!["wide"]);
        assert_eq!(image.attributes.value("width"), Some("480px"));

        assert!(parse_standalone_attributed_image_line(
            "before ![Alt](assets/pic.png){width=480px}"
        )
        .is_none());
        assert!(parse_standalone_attributed_image_line("![Alt](assets/pic.png)").is_none());
    }
}
