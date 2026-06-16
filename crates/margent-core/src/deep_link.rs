pub const MARGENT_DEEP_LINK_SCHEME: &str = "margent";

pub fn document_deep_link(workspace_root: &str, document_relative_path: &str) -> String {
    format!(
        "{MARGENT_DEEP_LINK_SCHEME}://open?workspace={}&doc={}",
        percent_encode(workspace_root),
        percent_encode(document_relative_path),
    )
}

pub fn thread_deep_link(
    workspace_root: &str,
    document_relative_path: &str,
    thread_id: &str,
) -> String {
    format!(
        "{}&thread={}",
        document_deep_link(workspace_root, document_relative_path),
        percent_encode(thread_id),
    )
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push(hex_digit(byte >> 4));
                encoded.push(hex_digit(byte & 0x0f));
            }
        }
    }
    encoded
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!("hex nibble out of range"),
    }
}

#[cfg(test)]
mod tests {
    use super::{document_deep_link, thread_deep_link};

    #[test]
    fn document_deep_link_encodes_workspace_and_document() {
        let link = document_deep_link(
            "/Users/example/Documents/My Workspace",
            "drafts/chapter one.md",
        );

        assert_eq!(
            link,
            "margent://open?workspace=%2FUsers%2Fexample%2FDocuments%2FMy%20Workspace&doc=drafts%2Fchapter%20one.md",
        );
    }

    #[test]
    fn thread_deep_link_encodes_workspace_document_and_thread() {
        let link = thread_deep_link(
            "/Users/example/Documents/My Workspace",
            "drafts/chapter one.md",
            "thread/with spaces",
        );

        assert_eq!(
            link,
            "margent://open?workspace=%2FUsers%2Fexample%2FDocuments%2FMy%20Workspace&doc=drafts%2Fchapter%20one.md&thread=thread%2Fwith%20spaces",
        );
    }
}
