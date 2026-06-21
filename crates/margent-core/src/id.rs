use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);
static PROCESS_SEED: OnceLock<u64> = OnceLock::new();

/// Generates a new Margent record ID with a readable UTC timestamp and a
/// process-local monotonic suffix.
pub fn new_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = format_timestamp_utc(now);
    let suffix = uniqueness_suffix(now, counter);

    format!("{prefix}_{timestamp}_{suffix}")
}

fn uniqueness_suffix(now: Duration, counter: u64) -> String {
    let micros = now.as_micros();
    let folded_micros = micros as u64 ^ (micros >> 64) as u64;
    let mixed = mix64(
        folded_micros ^ counter.rotate_left(17) ^ ((process::id() as u64) << 32) ^ process_seed(),
    );

    format!("{counter:012x}{mixed:016x}")
}

fn process_seed() -> u64 {
    *PROCESS_SEED.get_or_init(|| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_else(|_| Duration::from_secs(0));
        let stack_marker = 0_u8;
        let stack_addr = (&stack_marker as *const u8 as usize) as u64;
        mix64(now.as_nanos() as u64 ^ ((process::id() as u64) << 16) ^ stack_addr)
    })
}

fn format_timestamp_utc(duration: Duration) -> String {
    let secs = duration.as_secs();
    let days = (secs / 86_400) as i64;
    let seconds_of_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let micros = duration.subsec_micros();

    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}{micros:06}Z")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };

    (year as i32, month as u32, day as u32)
}

fn mix64(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;

    use super::*;
    use crate::document::DocumentRecord;
    use crate::event::EventRecord;
    use crate::proposal::ProposalRecord;
    use crate::thread::ThreadRecord;

    #[test]
    fn generated_ids_are_unique_and_timestamp_readable() {
        let mut ids = HashSet::new();

        for _ in 0..20_000 {
            let id = new_id("thread");
            assert!(ids.insert(id.clone()), "duplicate id generated: {id}");

            let parts: Vec<&str> = id.split('_').collect();
            assert_eq!(parts.len(), 3, "id should be prefix_timestamp_suffix");
            assert_eq!(parts[0], "thread");
            assert_eq!(parts[1].len(), 22);
            assert_eq!(&parts[1][8..9], "T");
            assert_eq!(&parts[1][21..22], "Z");
            assert!(
                parts[1][0..8]
                    .chars()
                    .all(|character| character.is_ascii_digit()),
                "date should be numeric: {id}"
            );
            assert!(
                parts[1][9..21]
                    .chars()
                    .all(|character| character.is_ascii_digit()),
                "time should be numeric: {id}"
            );
            assert_eq!(parts[2].len(), 28);
            assert!(
                parts[2]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()),
                "suffix should be hex: {id}"
            );
        }
    }

    #[test]
    fn timestamp_formatter_uses_utc_calendar_time() {
        let unix_epoch = Duration::from_secs(0);
        assert_eq!(format_timestamp_utc(unix_epoch), "19700101T000000000000Z");

        let known = Duration::new(1_767_225_599, 123_456_000);
        assert_eq!(format_timestamp_utc(known), "20251231T235959123456Z");
    }

    #[test]
    fn existing_records_keep_permissive_string_ids() {
        let document: DocumentRecord = serde_json::from_value(json!({
            "schemaVersion": 1,
            "id": "legacy document id with spaces",
            "relativePath": "draft.md",
            "displayName": "draft.md",
            "createdAt": "2026-06-20T00:00:00Z",
            "updatedAt": "2026-06-20T00:00:00Z",
            "currentContentHash": "sha256:abc",
            "lastKnownLineEnding": "lf",
            "frontmatterMode": "none",
            "wordCount": 0,
            "headingIndex": []
        }))
        .expect("document record should accept legacy string ids");
        assert_eq!(document.id, "legacy document id with spaces");

        let proposal: ProposalRecord = serde_json::from_value(json!({
            "schemaVersion": 1,
            "id": "proposal/legacy:1",
            "documentId": "legacy document id with spaces",
            "threadIds": ["thread legacy"],
            "adapterId": "codex",
            "createdAt": "2026-06-20T00:00:00Z",
            "updatedAt": "2026-06-20T00:00:00Z",
            "status": "pending",
            "baseContentHash": "sha256:abc",
            "responseMode": "replace_document",
            "summary": "Summary",
            "assistantMessage": "Message",
            "updatedDocumentText": null,
            "unifiedDiff": null,
            "computedDiff": "",
            "warnings": [],
            "resolveThreadIds": [],
            "stderr": null,
            "errorMessage": null
        }))
        .expect("proposal record should accept legacy string ids");
        assert_eq!(proposal.id, "proposal/legacy:1");
        assert_eq!(proposal.document_id, "legacy document id with spaces");

        let event: EventRecord = serde_json::from_value(json!({
            "id": "event legacy",
            "timestamp": "2026-06-20T00:00:00Z",
            "eventType": "proposal.created",
            "threadId": "thread legacy",
            "documentId": "legacy document id with spaces",
            "proposalId": "proposal/legacy:1",
            "body": "ok"
        }))
        .expect("event record should accept legacy string ids");
        assert_eq!(event.id, "event legacy");
        assert_eq!(event.proposal_id.as_deref(), Some("proposal/legacy:1"));

        let thread: ThreadRecord = serde_json::from_value(json!({
            "schemaVersion": 6,
            "id": "thread legacy",
            "documentId": "legacy document id with spaces",
            "status": "open",
            "createdAt": "2026-06-20T00:00:00Z",
            "updatedAt": "2026-06-20T00:00:00Z",
            "createdBy": "human",
            "title": "Thread",
            "tags": [],
            "anchor": {
                "quote": "quote",
                "prefixContext": "",
                "suffixContext": "",
                "startOffsetUtf16": 0,
                "endOffsetUtf16": 5,
                "startLine": 1,
                "startColumn": 1,
                "endLine": 1,
                "endColumn": 6,
                "headingPath": [],
                "blockFingerprint": "fingerprint",
                "baseContentHash": "sha256:abc",
                "kind": "legacy anchor kind",
                "state": "attached",
                "confidence": 1.0
            },
            "createdContentHash": null,
            "lastReanchorContentHash": null,
            "reviewRound": null,
            "reviewDone": false,
            "messages": [{
                "id": "message legacy",
                "threadId": "thread legacy",
                "authorType": "human",
                "authorName": "Reviewer",
                "agentId": null,
                "adapterId": null,
                "replyToMessageId": null,
                "createdAt": "2026-06-20T00:00:00Z",
                "body": "Body",
                "kind": "comment"
            }],
            "linkedProposalIds": ["proposal/legacy:1"],
            "providerSessions": {"codex": "session legacy"}
        }))
        .expect("thread record should accept legacy string ids");
        assert_eq!(thread.id, "thread legacy");
        assert_eq!(thread.messages[0].id, "message legacy");
        assert_eq!(thread.linked_proposal_ids[0], "proposal/legacy:1");
    }
}
