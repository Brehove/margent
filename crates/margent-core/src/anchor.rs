use std::collections::{BTreeSet, HashMap, HashSet};

use crate::document::{content_hash, HeadingIndexEntry};
use crate::thread::AnchorRecord;

const NEEDS_REVIEW_THRESHOLD: f32 = 0.55;
const CLEAR_WINNER_DELTA: f32 = 0.1;
const STRUCTURED_NEEDS_REVIEW_THRESHOLD: f32 = 0.4;
const STRUCTURED_CLEAR_WINNER_DELTA: f32 = 0.04;
const MIN_FUZZY_QUOTE_SIMILARITY: f32 = 0.24;
const MAX_FUZZY_BLOCK_CANDIDATES: usize = 32;
const MAX_FUZZY_WINDOW_EVALUATIONS: usize = 320;
const MAX_WINDOWED_FUZZY_QUOTE_CHARS: usize = 900;
const MAX_WINDOWED_FUZZY_QUOTE_WORDS: usize = 120;
const FOCUSED_FUZZY_RADIUS_TOKENS: usize = 36;

pub fn reattach_anchor(
    anchor: &mut AnchorRecord,
    content: &str,
    heading_index: &[HeadingIndexEntry],
) -> bool {
    ReattachmentContext::new(content, heading_index).reattach_anchor(anchor)
}

pub struct ReattachmentContext<'a> {
    content: &'a str,
    content_hash: String,
    heading_index: &'a [HeadingIndexEntry],
    blocks: Vec<DocumentBlock>,
}

impl<'a> ReattachmentContext<'a> {
    pub fn new(content: &'a str, heading_index: &'a [HeadingIndexEntry]) -> Self {
        Self {
            content,
            content_hash: content_hash(content),
            heading_index,
            blocks: collect_blocks(content, heading_index),
        }
    }

    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    pub fn reattach_anchor(&self, anchor: &mut AnchorRecord) -> bool {
        let outcome = resolve_anchor_with_context(
            anchor,
            self.content,
            self.heading_index,
            &self.blocks,
            &self.content_hash,
        );
        apply_reattachment_outcome(anchor, outcome)
    }
}

fn apply_reattachment_outcome(anchor: &mut AnchorRecord, outcome: ReattachmentOutcome) -> bool {
    let original = anchor.clone();

    anchor.state = outcome.state.into();
    anchor.confidence = outcome.confidence;

    if let Some(range) = outcome.range {
        anchor.start_offset_utf16 = range.start_offset_utf16;
        anchor.end_offset_utf16 = range.end_offset_utf16;
        anchor.start_line = range.start_line;
        anchor.start_column = range.start_column;
        anchor.end_line = range.end_line;
        anchor.end_column = range.end_column;
    }

    anchor != &original
}

fn resolve_anchor_with_context(
    anchor: &AnchorRecord,
    content: &str,
    heading_index: &[HeadingIndexEntry],
    blocks: &[DocumentBlock],
    current_content_hash: &str,
) -> ReattachmentOutcome {
    if let Some(range) = exact_range_match(anchor, content, blocks, current_content_hash) {
        let state = if anchor.base_content_hash == current_content_hash
            || range.start_offset_utf16 == anchor.start_offset_utf16
        {
            "attached"
        } else {
            "shifted"
        };

        return ReattachmentOutcome {
            confidence: 1.0,
            range: Some(range),
            state,
        };
    }

    if let Some(outcome) = resolve_footnote_anchor(anchor, content, heading_index, blocks) {
        return outcome;
    }

    let exact_quote_matches = collect_quote_matches(&anchor.quote, content);
    let scored = if exact_quote_matches.is_empty() {
        score_fuzzy_block_candidates(anchor, content, blocks)
    } else {
        score_exact_quote_matches(anchor, content, blocks, exact_quote_matches)
    };

    let Some(best) = scored.first() else {
        return ReattachmentOutcome {
            confidence: 0.0,
            range: None,
            state: "detached",
        };
    };

    let runner_up_score = scored.get(1).map(|entry| entry.score).unwrap_or(0.0);
    let has_clear_winner = best.score - runner_up_score >= CLEAR_WINNER_DELTA;

    if best.score < NEEDS_REVIEW_THRESHOLD || !has_clear_winner {
        return ReattachmentOutcome {
            confidence: best.score.max(0.0),
            range: Some(best.range.clone()),
            state: "needs_review",
        };
    }

    let state = if best.exact_quote {
        if best.range.start_offset_utf16 == anchor.start_offset_utf16 {
            "attached"
        } else if (best.prefix_matches && best.suffix_matches)
            || best.fingerprint_matches
            || best.heading_similarity >= 0.99
        {
            "shifted"
        } else {
            "fuzzy"
        }
    } else {
        "fuzzy"
    };

    ReattachmentOutcome {
        confidence: best.score.clamp(0.0, 1.0),
        range: Some(best.range.clone()),
        state,
    }
}

fn resolve_footnote_anchor(
    anchor: &AnchorRecord,
    content: &str,
    heading_index: &[HeadingIndexEntry],
    blocks: &[DocumentBlock],
) -> Option<ReattachmentOutcome> {
    let footnote = anchor.footnote.as_ref()?;

    match anchor.kind.as_str() {
        "footnote_reference" => {
            let candidates: Vec<FootnoteReference> = collect_footnote_references(content)
                .into_iter()
                .filter(|candidate| candidate.label == footnote.label)
                .collect();

            let scored = score_footnote_reference_candidates(
                anchor,
                content,
                blocks,
                &candidates,
                footnote.occurrence,
            );
            resolve_structured_range(anchor, scored)
        }
        "footnote_definition" => {
            let candidates: Vec<FootnoteDefinition> = collect_footnote_definitions(content)
                .into_iter()
                .filter(|candidate| candidate.label == footnote.label)
                .collect();
            let definition = choose_footnote_definition_candidate(
                anchor,
                content,
                heading_index,
                blocks,
                &candidates,
                footnote.occurrence,
            )?;

            let block = DocumentBlock {
                start_offset_utf16: definition.candidate.block_range.start_offset_utf16,
                end_offset_utf16: definition.candidate.block_range.end_offset_utf16,
                heading_path: resolve_heading_path(
                    heading_index,
                    definition.candidate.block_range.start_line,
                ),
                fingerprint: block_fingerprint(&definition.candidate.block_text),
                text: definition.candidate.block_text.clone(),
            };
            let exact_quote_matches = collect_quote_matches_in_range(
                &anchor.quote,
                content,
                definition.candidate.block_range.start_offset_utf16,
                definition.candidate.block_range.end_offset_utf16,
            );
            let scored = if exact_quote_matches.is_empty() {
                score_fuzzy_block_candidates(anchor, content, &[block])
            } else {
                score_exact_quote_matches(anchor, content, &[block], exact_quote_matches)
            };
            let best = scored.first()?;
            let runner_up_score = scored.get(1).map(|entry| entry.score).unwrap_or(0.0);
            let has_clear_winner = best.score - runner_up_score >= CLEAR_WINNER_DELTA;
            let confidence = (best.score * 0.7 + definition.score * 0.3).clamp(0.0, 1.0);

            if confidence < NEEDS_REVIEW_THRESHOLD || !has_clear_winner {
                return Some(ReattachmentOutcome {
                    confidence,
                    range: Some(best.range.clone()),
                    state: "needs_review",
                });
            }

            let state = if best.exact_quote {
                structured_match_state(anchor, &best.range)
            } else {
                "fuzzy"
            };

            Some(ReattachmentOutcome {
                confidence: confidence.max(NEEDS_REVIEW_THRESHOLD),
                range: Some(best.range.clone()),
                state,
            })
        }
        _ => None,
    }
}

fn resolve_structured_range(
    anchor: &AnchorRecord,
    scored: Vec<ScoredStructuredRange>,
) -> Option<ReattachmentOutcome> {
    let best = scored.first()?;
    let runner_up_score = scored.get(1).map(|entry| entry.score).unwrap_or(0.0);
    let has_clear_winner = best.score - runner_up_score >= STRUCTURED_CLEAR_WINNER_DELTA;

    if best.score < STRUCTURED_NEEDS_REVIEW_THRESHOLD || !has_clear_winner {
        return Some(ReattachmentOutcome {
            confidence: best.score.max(0.0),
            range: Some(best.range.clone()),
            state: "needs_review",
        });
    }

    Some(ReattachmentOutcome {
        confidence: best.score.clamp(0.0, 1.0).max(NEEDS_REVIEW_THRESHOLD),
        range: Some(best.range.clone()),
        state: structured_match_state(anchor, &best.range),
    })
}

fn structured_match_state(anchor: &AnchorRecord, range: &ResolvedRange) -> &'static str {
    if range.start_offset_utf16 == anchor.start_offset_utf16 {
        "attached"
    } else {
        "shifted"
    }
}

fn score_footnote_reference_candidates(
    anchor: &AnchorRecord,
    content: &str,
    blocks: &[DocumentBlock],
    candidates: &[FootnoteReference],
    expected_occurrence: usize,
) -> Vec<ScoredStructuredRange> {
    let expected_heading =
        (!anchor.heading_path.is_empty()).then_some(anchor.heading_path.as_slice());
    let mut scored = Vec::new();

    for candidate in candidates {
        let context = context_evidence(anchor, content, &candidate.range);
        let block = find_block_for_offset(blocks, candidate.range.start_offset_utf16);
        let heading_similarity = block
            .map(|entry| heading_path_similarity(expected_heading, Some(&entry.heading_path)))
            .unwrap_or(0.0);
        let fingerprint_matches = block
            .map(|entry| entry.fingerprint == anchor.block_fingerprint)
            .unwrap_or(false);
        let line_bonus = line_proximity_bonus(anchor.start_line, candidate.range.start_line);
        let distance_penalty = (distance_penalty(
            anchor.start_offset_utf16,
            candidate.range.start_offset_utf16,
        ) * 0.5)
            .min(0.08);
        let occurrence_penalty =
            (candidate.occurrence.abs_diff(expected_occurrence) as f32 * 0.03).min(0.08);

        let mut score = 0.12;
        score += context.prefix_similarity * 0.24;
        score += context.suffix_similarity * 0.24;
        score += heading_similarity * 0.08;
        score += line_bonus;
        score -= distance_penalty;
        score -= occurrence_penalty;

        if context.prefix_matches {
            score += 0.12;
        }

        if context.suffix_matches {
            score += 0.12;
        }

        if context.prefix_matches && context.suffix_matches {
            score += 0.1;
        }

        if fingerprint_matches {
            score += 0.08;
        }

        if candidate.occurrence == expected_occurrence {
            score += 0.03;
        }

        scored.push(ScoredStructuredRange {
            range: candidate.range.clone(),
            score: score.clamp(0.0, 1.0),
        });
    }

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    scored
}

fn choose_footnote_definition_candidate(
    anchor: &AnchorRecord,
    _content: &str,
    heading_index: &[HeadingIndexEntry],
    blocks: &[DocumentBlock],
    candidates: &[FootnoteDefinition],
    expected_occurrence: usize,
) -> Option<ScoredFootnoteDefinition> {
    let expected_heading =
        (!anchor.heading_path.is_empty()).then_some(anchor.heading_path.as_slice());
    let mut scored = Vec::new();

    for candidate in candidates {
        let block = find_block_for_offset(blocks, candidate.block_range.start_offset_utf16);
        let heading_similarity = block
            .map(|entry| heading_path_similarity(expected_heading, Some(&entry.heading_path)))
            .unwrap_or_else(|| {
                let candidate_heading =
                    resolve_heading_path(heading_index, candidate.block_range.start_line);
                heading_path_similarity(expected_heading, Some(candidate_heading.as_slice()))
            });
        let fingerprint_matches = block
            .map(|entry| entry.fingerprint == anchor.block_fingerprint)
            .unwrap_or_else(|| {
                block_fingerprint(&candidate.block_text) == anchor.block_fingerprint
            });
        let line_bonus = line_proximity_bonus(anchor.start_line, candidate.block_range.start_line);
        let distance_penalty = distance_penalty(
            anchor.start_offset_utf16,
            candidate.block_range.start_offset_utf16,
        );
        let occurrence_penalty =
            (candidate.occurrence.abs_diff(expected_occurrence) as f32 * 0.06).min(0.16);

        let mut score = 0.28;
        score += heading_similarity * 0.14;
        score += line_bonus;
        score -= distance_penalty;
        score -= occurrence_penalty;

        if fingerprint_matches {
            score += 0.28;
        }

        if candidate.occurrence == expected_occurrence {
            score += 0.12;
        }

        scored.push(ScoredFootnoteDefinition {
            candidate: candidate.clone(),
            score: score.clamp(0.0, 1.0),
        });
    }

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    scored.into_iter().next()
}

fn collect_quote_matches_in_range(
    quote: &str,
    content: &str,
    start_offset_utf16: usize,
    end_offset_utf16: usize,
) -> Vec<ResolvedRange> {
    let Ok(slice) = slice_utf16(content, start_offset_utf16, end_offset_utf16) else {
        return Vec::new();
    };
    let base_utf16_offset = start_offset_utf16;
    let quote_utf16_len = quote.encode_utf16().count();

    slice
        .match_indices(quote)
        .map(|(byte_start, _)| {
            let start = base_utf16_offset + byte_to_utf16_index(slice, byte_start);
            range_from_utf16_offsets(content, start, start + quote_utf16_len)
        })
        .collect()
}

fn collect_footnote_references(content: &str) -> Vec<FootnoteReference> {
    let mut references = Vec::new();
    let mut occurrence_by_label = HashMap::new();
    let mut search_start = 0usize;

    while let Some(relative_start) = content[search_start..].find("[^") {
        let token_start = search_start + relative_start;
        let line_end = content[token_start..]
            .find('\n')
            .map(|offset| token_start + offset)
            .unwrap_or(content.len());
        let Some(relative_close) = content[token_start..line_end].find(']') else {
            break;
        };
        let token_end = token_start + relative_close + 1;

        if token_end <= token_start + 2 {
            search_start = token_end;
            continue;
        }

        if is_footnote_definition_token(content, token_start, token_end) {
            search_start = token_end;
            continue;
        }

        let label = &content[token_start + 2..token_end - 1];
        let occurrence = {
            let next = occurrence_by_label.get(label).copied().unwrap_or(0) + 1;
            occurrence_by_label.insert(label.to_string(), next);
            next
        };
        let start_offset_utf16 = byte_to_utf16_index(content, token_start);
        let end_offset_utf16 = byte_to_utf16_index(content, token_end);

        references.push(FootnoteReference {
            label: label.to_string(),
            occurrence,
            range: range_from_utf16_offsets(content, start_offset_utf16, end_offset_utf16),
        });

        search_start = token_end;
    }

    references
}

fn collect_footnote_definitions(content: &str) -> Vec<FootnoteDefinition> {
    let lines = collect_line_infos(content);
    let mut definitions = Vec::new();
    let mut occurrence_by_label = HashMap::new();
    let mut index = 0usize;

    while index < lines.len() {
        let line = &lines[index];
        let Some((label, _indent_bytes)) = parse_footnote_definition_line(line.body) else {
            index += 1;
            continue;
        };
        let mut block_end_index = index;

        while block_end_index + 1 < lines.len() {
            let next = &lines[block_end_index + 1];
            if next.body.trim().is_empty()
                || next.body.starts_with("    ")
                || next.body.starts_with('\t')
            {
                block_end_index += 1;
                continue;
            }
            break;
        }

        let occurrence = {
            let next = occurrence_by_label.get(label).copied().unwrap_or(0) + 1;
            occurrence_by_label.insert(label.to_string(), next);
            next
        };
        let block_start_utf16 = line.start_offset_utf16;
        let block_end_utf16 = lines[block_end_index].end_offset_utf16;

        definitions.push(FootnoteDefinition {
            label: label.to_string(),
            occurrence,
            block_range: range_from_utf16_offsets(content, block_start_utf16, block_end_utf16),
            block_text: content[line.start_byte..lines[block_end_index].end_byte].to_string(),
        });

        index = block_end_index + 1;
    }

    definitions
}

fn parse_footnote_definition_line(line: &str) -> Option<(&str, usize)> {
    let indent_bytes = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent_bytes > 3 {
        return None;
    }

    let rest = &line[indent_bytes..];
    if !rest.starts_with("[^") {
        return None;
    }

    let closing_bracket = rest.find("]:")?;
    let label = &rest[2..closing_bracket];
    if label.is_empty() {
        return None;
    }

    Some((label, indent_bytes))
}

fn is_footnote_definition_token(content: &str, token_start: usize, token_end: usize) -> bool {
    if content.as_bytes().get(token_end) != Some(&b':') {
        return false;
    }

    let line_start = content[..token_start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    content[line_start..token_start]
        .bytes()
        .all(|byte| byte == b' ')
        && token_start - line_start <= 3
}

fn collect_line_infos(content: &str) -> Vec<LineInfo<'_>> {
    let mut lines = Vec::new();
    let mut byte_cursor = 0usize;
    let mut utf16_cursor = 0usize;
    for raw_line in content.split_inclusive('\n') {
        let body = raw_line
            .strip_suffix('\n')
            .unwrap_or(raw_line)
            .strip_suffix('\r')
            .unwrap_or_else(|| raw_line.strip_suffix('\n').unwrap_or(raw_line));
        let end_byte = byte_cursor + body.len();
        let end_offset_utf16 = utf16_cursor + body.encode_utf16().count();

        lines.push(LineInfo {
            body,
            start_byte: byte_cursor,
            end_byte,
            start_offset_utf16: utf16_cursor,
            end_offset_utf16,
        });

        byte_cursor += raw_line.len();
        utf16_cursor += raw_line.encode_utf16().count();
    }

    if content.is_empty() {
        lines.push(LineInfo {
            body: "",
            start_byte: 0,
            end_byte: 0,
            start_offset_utf16: 0,
            end_offset_utf16: 0,
        });
    }

    lines
}

fn exact_range_match(
    anchor: &AnchorRecord,
    content: &str,
    blocks: &[DocumentBlock],
    current_content_hash: &str,
) -> Option<ResolvedRange> {
    if anchor.start_offset_utf16 >= anchor.end_offset_utf16 {
        return None;
    }

    let Ok(slice) = slice_utf16(content, anchor.start_offset_utf16, anchor.end_offset_utf16) else {
        return None;
    };

    if slice != anchor.quote {
        return None;
    }

    let range =
        range_from_utf16_offsets(content, anchor.start_offset_utf16, anchor.end_offset_utf16);

    if anchor.base_content_hash == current_content_hash {
        return Some(range);
    }

    let block = find_block_for_offset(blocks, range.start_offset_utf16);
    let heading_similarity = block
        .map(|entry| {
            heading_path_similarity(
                Some(anchor.heading_path.as_slice()),
                Some(&entry.heading_path),
            )
        })
        .unwrap_or(0.0);
    let fingerprint_matches = block
        .map(|entry| entry.fingerprint == anchor.block_fingerprint)
        .unwrap_or(false);

    if fingerprint_matches && heading_similarity >= 0.99 {
        Some(range)
    } else {
        None
    }
}

fn score_exact_quote_matches(
    anchor: &AnchorRecord,
    content: &str,
    blocks: &[DocumentBlock],
    matches: Vec<ResolvedRange>,
) -> Vec<ScoredCandidate> {
    let match_count = matches.len();
    let expected_heading =
        (!anchor.heading_path.is_empty()).then_some(anchor.heading_path.as_slice());
    let mut scored = Vec::new();

    for range in matches {
        let context = context_evidence(anchor, content, &range);
        let block = find_block_for_offset(blocks, range.start_offset_utf16);
        let heading_similarity = block
            .map(|entry| heading_path_similarity(expected_heading, Some(&entry.heading_path)))
            .unwrap_or(0.0);
        let fingerprint_matches = block
            .map(|entry| entry.fingerprint == anchor.block_fingerprint)
            .unwrap_or(false);
        let line_bonus = line_proximity_bonus(anchor.start_line, range.start_line);
        let distance_penalty =
            distance_penalty(anchor.start_offset_utf16, range.start_offset_utf16);

        let mut score = if match_count == 1 { 0.4 } else { 0.18 };
        score += context.prefix_similarity * 0.12;
        score += context.suffix_similarity * 0.12;
        score += heading_similarity * 0.18;
        score += line_bonus;
        score -= distance_penalty;

        if context.prefix_matches {
            score += 0.06;
        }

        if context.suffix_matches {
            score += 0.06;
        }

        if fingerprint_matches {
            score += 0.22;
        }

        scored.push(ScoredCandidate {
            exact_quote: true,
            fingerprint_matches,
            heading_similarity,
            prefix_matches: context.prefix_matches,
            range,
            score: score.clamp(0.0, 1.0),
            suffix_matches: context.suffix_matches,
        });
    }

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    scored
}

fn score_fuzzy_block_candidates(
    anchor: &AnchorRecord,
    content: &str,
    blocks: &[DocumentBlock],
) -> Vec<ScoredCandidate> {
    let expected_heading =
        (!anchor.heading_path.is_empty()).then_some(anchor.heading_path.as_slice());
    let mut block_candidates = Vec::new();
    let mut scored = Vec::new();

    for block in blocks {
        let heading_similarity =
            heading_path_similarity(expected_heading, Some(block.heading_path.as_slice()));
        let fingerprint_matches = block.fingerprint == anchor.block_fingerprint;

        if !fingerprint_matches && heading_similarity < 0.18 {
            continue;
        }

        block_candidates.push(FuzzyBlockCandidate {
            block,
            fingerprint_matches,
            heading_similarity,
            offset_distance: anchor.start_offset_utf16.abs_diff(block.start_offset_utf16),
        });
    }

    block_candidates.sort_by(|left, right| {
        right
            .fingerprint_matches
            .cmp(&left.fingerprint_matches)
            .then_with(|| right.heading_similarity.total_cmp(&left.heading_similarity))
            .then_with(|| left.offset_distance.cmp(&right.offset_distance))
    });

    for candidate in block_candidates
        .into_iter()
        .take(MAX_FUZZY_BLOCK_CANDIDATES)
    {
        let block = candidate.block;
        let heading_similarity = candidate.heading_similarity;
        let fingerprint_matches = candidate.fingerprint_matches;

        let Some(best_window) = best_fuzzy_window_for_block(anchor, content, block) else {
            continue;
        };

        if !fingerprint_matches && best_window.quote_similarity < MIN_FUZZY_QUOTE_SIMILARITY {
            continue;
        }

        let line_bonus = line_proximity_bonus(anchor.start_line, best_window.range.start_line);
        let distance_penalty = distance_penalty(
            anchor.start_offset_utf16,
            best_window.range.start_offset_utf16,
        );

        let mut score = 0.08;
        score += best_window.quote_similarity * 0.42;
        score += best_window.prefix_similarity * 0.12;
        score += best_window.suffix_similarity * 0.12;
        score += heading_similarity * 0.14;
        score += line_bonus;
        score -= distance_penalty;

        if fingerprint_matches {
            score += 0.22;
        }

        scored.push(ScoredCandidate {
            exact_quote: false,
            fingerprint_matches,
            heading_similarity,
            prefix_matches: best_window.prefix_matches,
            range: best_window.range,
            score: score.clamp(0.0, 1.0),
            suffix_matches: best_window.suffix_matches,
        });
    }

    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    scored
}

fn best_fuzzy_window_for_block(
    anchor: &AnchorRecord,
    content: &str,
    block: &DocumentBlock,
) -> Option<FuzzyWindow> {
    let token_spans = collect_token_spans(&block.text);
    let expected_words = anchor.quote.split_whitespace().count().max(1);

    if anchor.quote.len() > MAX_WINDOWED_FUZZY_QUOTE_CHARS
        || expected_words > MAX_WINDOWED_FUZZY_QUOTE_WORDS
    {
        return fuzzy_block_window(anchor, content, block);
    }

    let min_words = expected_words.saturating_sub(2).max(1);
    let max_words = (expected_words + 2).min(token_spans.len().max(1));
    let mut best_window: Option<FuzzyWindow> = None;

    if token_spans.is_empty() {
        let range = block_range(content, block);
        let context = context_evidence(anchor, content, &range);

        return Some(FuzzyWindow {
            prefix_matches: context.prefix_matches,
            prefix_similarity: context.prefix_similarity,
            quote_similarity: text_similarity(&anchor.quote, &block.text),
            range,
            suffix_matches: context.suffix_matches,
            suffix_similarity: context.suffix_similarity,
        });
    }

    let lengths = (min_words..=max_words).collect::<Vec<_>>();
    let start_indices = fuzzy_window_start_indices(anchor, block, token_spans.len(), lengths.len());
    let mut evaluation_count = 0usize;

    'windows: for start_index in start_indices {
        for &length in &lengths {
            if evaluation_count >= MAX_FUZZY_WINDOW_EVALUATIONS {
                break 'windows;
            }
            let end_index = start_index + length;
            if end_index > token_spans.len() {
                break;
            }
            evaluation_count += 1;

            let byte_start = token_spans[start_index].start_byte;
            let byte_end = token_spans[end_index - 1].end_byte;
            let snippet = &block.text[byte_start..byte_end];
            let range = block_subrange(content, block, byte_start, byte_end);
            let context = context_evidence(anchor, content, &range);
            let quote_similarity = text_similarity(&anchor.quote, snippet);
            let score = quote_similarity * 0.72
                + context.prefix_similarity * 0.14
                + context.suffix_similarity * 0.14;

            let candidate = FuzzyWindow {
                prefix_matches: context.prefix_matches,
                prefix_similarity: context.prefix_similarity,
                quote_similarity,
                range,
                suffix_matches: context.suffix_matches,
                suffix_similarity: context.suffix_similarity,
            };

            let replace_current = best_window
                .as_ref()
                .map(|current| {
                    score > current.window_score()
                        || (score == current.window_score()
                            && quote_similarity > current.quote_similarity)
                })
                .unwrap_or(true);

            if replace_current {
                best_window = Some(candidate);
            }
        }
    }

    best_window
}

fn fuzzy_block_window(
    anchor: &AnchorRecord,
    content: &str,
    block: &DocumentBlock,
) -> Option<FuzzyWindow> {
    if block.text.trim().is_empty() {
        return None;
    }

    let range = block_range(content, block);
    let context = context_evidence(anchor, content, &range);

    Some(FuzzyWindow {
        prefix_matches: context.prefix_matches,
        prefix_similarity: context.prefix_similarity,
        quote_similarity: text_similarity(&anchor.quote, &block.text),
        range,
        suffix_matches: context.suffix_matches,
        suffix_similarity: context.suffix_similarity,
    })
}

fn fuzzy_window_start_indices(
    anchor: &AnchorRecord,
    block: &DocumentBlock,
    token_count: usize,
    length_count: usize,
) -> Vec<usize> {
    if token_count == 0 {
        return Vec::new();
    }

    if token_count.saturating_mul(length_count) <= MAX_FUZZY_WINDOW_EVALUATIONS {
        return (0..token_count).collect();
    }

    let mut indices = BTreeSet::new();
    let block_len_utf16 = block
        .end_offset_utf16
        .saturating_sub(block.start_offset_utf16)
        .max(1);
    let relative_utf16 = anchor
        .start_offset_utf16
        .saturating_sub(block.start_offset_utf16)
        .min(block_len_utf16);
    let estimated = relative_utf16.saturating_mul(token_count.saturating_sub(1)) / block_len_utf16;
    let focused_start = estimated.saturating_sub(FOCUSED_FUZZY_RADIUS_TOKENS);
    let focused_end = estimated
        .saturating_add(FOCUSED_FUZZY_RADIUS_TOKENS)
        .min(token_count.saturating_sub(1));

    for index in focused_start..=focused_end {
        indices.insert(index);
    }

    let target_starts = (MAX_FUZZY_WINDOW_EVALUATIONS / length_count.max(1)).max(1);
    if indices.len() < target_starts {
        let step = (token_count / target_starts).max(1);
        let mut index = 0usize;
        while index < token_count && indices.len() < target_starts {
            indices.insert(index);
            index = index.saturating_add(step);
        }
        indices.insert(token_count - 1);
    }

    indices.into_iter().collect()
}

fn collect_quote_matches(quote: &str, content: &str) -> Vec<ResolvedRange> {
    if quote.is_empty() {
        return Vec::new();
    }

    let quote_utf16_len = quote.encode_utf16().count();

    content
        .match_indices(quote)
        .map(|(byte_start, _)| {
            let start_offset_utf16 = byte_to_utf16_index(content, byte_start);
            range_from_utf16_offsets(
                content,
                start_offset_utf16,
                start_offset_utf16 + quote_utf16_len,
            )
        })
        .collect()
}

fn collect_blocks(content: &str, heading_index: &[HeadingIndexEntry]) -> Vec<DocumentBlock> {
    let mut blocks = Vec::new();
    let mut current: Option<WorkingBlock> = None;
    let mut byte_cursor = 0usize;
    let mut utf16_cursor = 0usize;

    for (line_number, raw_line) in (1usize..).zip(content.split_inclusive('\n')) {
        let line_body = raw_line
            .strip_suffix('\n')
            .unwrap_or(raw_line)
            .strip_suffix('\r')
            .unwrap_or_else(|| raw_line.strip_suffix('\n').unwrap_or(raw_line));
        let line_is_blank = line_body.trim().is_empty();
        let line_body_utf16_len = line_body.encode_utf16().count();

        if line_is_blank {
            if let Some(block) = current.take() {
                blocks.push(finalize_block(content, heading_index, block));
            }
        } else {
            let working_block = current.get_or_insert_with(|| WorkingBlock {
                start_byte: byte_cursor,
                start_line: line_number,
                start_offset_utf16: utf16_cursor,
                end_byte: byte_cursor + line_body.len(),
                end_offset_utf16: utf16_cursor + line_body_utf16_len,
            });
            working_block.end_byte = byte_cursor + line_body.len();
            working_block.end_offset_utf16 = utf16_cursor + line_body_utf16_len;
        }

        byte_cursor += raw_line.len();
        utf16_cursor += raw_line.encode_utf16().count();
    }

    if let Some(block) = current.take() {
        blocks.push(finalize_block(content, heading_index, block));
    }

    blocks
}

fn finalize_block(
    content: &str,
    heading_index: &[HeadingIndexEntry],
    block: WorkingBlock,
) -> DocumentBlock {
    let text = content[block.start_byte..block.end_byte].to_string();

    DocumentBlock {
        end_offset_utf16: block.end_offset_utf16,
        fingerprint: block_fingerprint(&text),
        heading_path: resolve_heading_path(heading_index, block.start_line),
        start_offset_utf16: block.start_offset_utf16,
        text,
    }
}

fn find_block_for_offset(blocks: &[DocumentBlock], offset_utf16: usize) -> Option<&DocumentBlock> {
    blocks.iter().find(|block| {
        block.start_offset_utf16 <= offset_utf16 && offset_utf16 <= block.end_offset_utf16
    })
}

fn block_range(content: &str, block: &DocumentBlock) -> ResolvedRange {
    range_from_utf16_offsets(content, block.start_offset_utf16, block.end_offset_utf16)
}

fn block_subrange(
    content: &str,
    block: &DocumentBlock,
    start_byte_in_block: usize,
    end_byte_in_block: usize,
) -> ResolvedRange {
    let start_offset_utf16 =
        block.start_offset_utf16 + byte_to_utf16_index(&block.text, start_byte_in_block);
    let end_offset_utf16 =
        block.start_offset_utf16 + byte_to_utf16_index(&block.text, end_byte_in_block);

    range_from_utf16_offsets(content, start_offset_utf16, end_offset_utf16)
}

fn context_evidence(
    anchor: &AnchorRecord,
    content: &str,
    range: &ResolvedRange,
) -> ContextEvidence {
    let byte_start = utf16_to_byte_index(content, range.start_offset_utf16).unwrap_or(0);
    let byte_end = utf16_to_byte_index(content, range.end_offset_utf16).unwrap_or(byte_start);
    let before = &content[..byte_start];
    let after = &content[byte_end..];
    let prefix_matches =
        anchor.prefix_context.is_empty() || before.ends_with(&anchor.prefix_context);
    let suffix_matches =
        anchor.suffix_context.is_empty() || after.starts_with(&anchor.suffix_context);
    let prefix_similarity = edge_similarity(&anchor.prefix_context, before, Edge::Suffix);
    let suffix_similarity = edge_similarity(&anchor.suffix_context, after, Edge::Prefix);

    ContextEvidence {
        prefix_matches,
        prefix_similarity,
        suffix_matches,
        suffix_similarity,
    }
}

fn edge_similarity(expected: &str, candidate: &str, edge: Edge) -> f32 {
    if expected.trim().is_empty() {
        return 1.0;
    }

    let expected_char_count = expected.chars().count().max(1);
    let candidate_window = match edge {
        Edge::Prefix => take_first_chars(candidate, expected_char_count.saturating_mul(2)),
        Edge::Suffix => take_last_chars(candidate, expected_char_count.saturating_mul(2)),
    };

    text_similarity(expected, candidate_window)
}

fn take_first_chars(value: &str, count: usize) -> &str {
    if count == 0 {
        return "";
    }

    let mut byte_index = value.len();
    let mut seen = 0usize;

    for (index, character) in value.char_indices() {
        seen += character.len_utf16();

        if seen >= count {
            byte_index = index + character.len_utf8();
            break;
        }
    }

    &value[..byte_index]
}

fn take_last_chars(value: &str, count: usize) -> &str {
    if count == 0 {
        return "";
    }

    let mut byte_index = 0usize;
    let mut seen = 0usize;

    for (index, character) in value.char_indices().rev() {
        seen += character.len_utf16();
        byte_index = index;

        if seen >= count {
            break;
        }
    }

    &value[byte_index..]
}

fn heading_path_similarity(expected: Option<&[String]>, actual: Option<&[String]>) -> f32 {
    let Some(expected) = expected else {
        return 0.0;
    };
    let Some(actual) = actual else {
        return 0.0;
    };

    if expected.is_empty() || actual.is_empty() {
        return 0.0;
    }

    let expected_normalized: Vec<String> =
        expected.iter().map(|value| normalize_text(value)).collect();
    let actual_normalized: Vec<String> = actual.iter().map(|value| normalize_text(value)).collect();

    if expected_normalized == actual_normalized {
        return 1.0;
    }

    let common_prefix = expected_normalized
        .iter()
        .zip(actual_normalized.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let prefix_score =
        common_prefix as f32 / expected_normalized.len().max(actual_normalized.len()) as f32;
    let leaf_bonus = expected_normalized
        .last()
        .zip(actual_normalized.last())
        .map(|(left, right)| if left == right { 0.25 } else { 0.0 })
        .unwrap_or(0.0);

    (prefix_score * 0.75 + leaf_bonus).min(1.0)
}

fn line_proximity_bonus(expected_line: usize, actual_line: usize) -> f32 {
    let distance = expected_line.abs_diff(actual_line) as f32;
    (1.0 - (distance / 120.0).min(1.0)) * 0.08
}

fn distance_penalty(expected_offset: usize, actual_offset: usize) -> f32 {
    (expected_offset.abs_diff(actual_offset) as f32 / 5000.0).min(0.16)
}

fn collect_token_spans(text: &str) -> Vec<TextSpan> {
    let mut spans = Vec::new();
    let mut current_start = None;

    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            if let Some(start_byte) = current_start.take() {
                spans.push(TextSpan {
                    end_byte: index,
                    start_byte,
                });
            }
        } else if current_start.is_none() {
            current_start = Some(index);
        }
    }

    if let Some(start_byte) = current_start {
        spans.push(TextSpan {
            end_byte: text.len(),
            start_byte,
        });
    }

    spans
}

fn text_similarity(left: &str, right: &str) -> f32 {
    let left_normalized = normalize_text(left);
    let right_normalized = normalize_text(right);

    if left_normalized.is_empty() || right_normalized.is_empty() {
        return 0.0;
    }

    if left_normalized == right_normalized {
        return 1.0;
    }

    let dice = dice_coefficient(&left_normalized, &right_normalized);
    let token = token_similarity(&left_normalized, &right_normalized);

    (dice * 0.7 + token * 0.3).min(1.0)
}

fn normalize_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut needs_space = false;

    for character in value.chars() {
        if character.is_whitespace() {
            if !normalized.is_empty() {
                needs_space = true;
            }
            continue;
        }

        if needs_space && !normalized.is_empty() {
            normalized.push(' ');
        }

        for lowered in character.to_lowercase() {
            normalized.push(lowered);
        }

        needs_space = false;
    }

    normalized
}

fn dice_coefficient(left: &str, right: &str) -> f32 {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();

    if left_chars.len() < 2 || right_chars.len() < 2 {
        return if left == right { 1.0 } else { 0.0 };
    }

    let mut left_bigrams: HashMap<(char, char), usize> = HashMap::new();

    for pair in left_chars.windows(2) {
        *left_bigrams.entry((pair[0], pair[1])).or_insert(0) += 1;
    }

    let mut intersection = 0usize;

    for pair in right_chars.windows(2) {
        if let Some(count) = left_bigrams.get_mut(&(pair[0], pair[1])) {
            if *count > 0 {
                *count -= 1;
                intersection += 1;
            }
        }
    }

    (2 * intersection) as f32 / (left_chars.len() + right_chars.len() - 2) as f32
}

fn token_similarity(left: &str, right: &str) -> f32 {
    let left_tokens: HashSet<&str> = left.split(' ').filter(|value| !value.is_empty()).collect();
    let right_tokens: HashSet<&str> = right.split(' ').filter(|value| !value.is_empty()).collect();

    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }

    let intersection = left_tokens.intersection(&right_tokens).count() as f32;
    let union = left_tokens.union(&right_tokens).count() as f32;

    if union == 0.0 {
        0.0
    } else {
        intersection / union
    }
}

fn block_fingerprint(block_text: &str) -> String {
    content_hash(&normalize_text(block_text))
}

fn range_from_utf16_offsets(
    content: &str,
    start_offset_utf16: usize,
    end_offset_utf16: usize,
) -> ResolvedRange {
    let (start_line, start_column) = utf16_offset_to_line_column(content, start_offset_utf16);
    let (end_line, end_column) = utf16_offset_to_line_column(content, end_offset_utf16);

    ResolvedRange {
        start_offset_utf16,
        end_offset_utf16,
        start_line,
        start_column,
        end_line,
        end_column,
    }
}

fn slice_utf16(content: &str, start: usize, end: usize) -> Result<&str, ()> {
    let byte_start = utf16_to_byte_index(content, start).ok_or(())?;
    let byte_end = utf16_to_byte_index(content, end).ok_or(())?;
    content.get(byte_start..byte_end).ok_or(())
}

fn utf16_to_byte_index(content: &str, target_utf16: usize) -> Option<usize> {
    if target_utf16 == 0 {
        return Some(0);
    }

    let mut utf16_index = 0usize;

    for (byte_index, character) in content.char_indices() {
        if utf16_index == target_utf16 {
            return Some(byte_index);
        }

        utf16_index += character.len_utf16();

        if utf16_index == target_utf16 {
            return Some(byte_index + character.len_utf8());
        }
    }

    if utf16_index == target_utf16 {
        Some(content.len())
    } else {
        None
    }
}

fn byte_to_utf16_index(content: &str, byte_index: usize) -> usize {
    content[..byte_index].encode_utf16().count()
}

fn utf16_offset_to_line_column(content: &str, target_utf16: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut line_start_utf16 = 0usize;
    let mut utf16_index = 0usize;

    for character in content.chars() {
        if utf16_index >= target_utf16 {
            break;
        }

        let width = character.len_utf16();
        utf16_index += width;

        if character == '\n' && utf16_index <= target_utf16 {
            line += 1;
            line_start_utf16 = utf16_index;
        }
    }

    (line, target_utf16.saturating_sub(line_start_utf16) + 1)
}

fn resolve_heading_path(headings: &[HeadingIndexEntry], line: usize) -> Vec<String> {
    let mut stack: Vec<&HeadingIndexEntry> = Vec::new();

    for heading in headings {
        if heading.line > line {
            break;
        }

        while stack
            .last()
            .map(|current| current.depth >= heading.depth)
            .unwrap_or(false)
        {
            stack.pop();
        }

        stack.push(heading);
    }

    stack
        .into_iter()
        .map(|heading| heading.text.clone())
        .collect()
}

#[derive(Clone)]
struct ResolvedRange {
    start_offset_utf16: usize,
    end_offset_utf16: usize,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
}

struct ReattachmentOutcome {
    state: &'static str,
    confidence: f32,
    range: Option<ResolvedRange>,
}

struct WorkingBlock {
    start_byte: usize,
    start_line: usize,
    start_offset_utf16: usize,
    end_byte: usize,
    end_offset_utf16: usize,
}

struct DocumentBlock {
    start_offset_utf16: usize,
    end_offset_utf16: usize,
    heading_path: Vec<String>,
    fingerprint: String,
    text: String,
}

struct ContextEvidence {
    prefix_matches: bool,
    prefix_similarity: f32,
    suffix_matches: bool,
    suffix_similarity: f32,
}

struct ScoredCandidate {
    exact_quote: bool,
    fingerprint_matches: bool,
    heading_similarity: f32,
    prefix_matches: bool,
    range: ResolvedRange,
    score: f32,
    suffix_matches: bool,
}

struct FuzzyWindow {
    prefix_matches: bool,
    prefix_similarity: f32,
    quote_similarity: f32,
    range: ResolvedRange,
    suffix_matches: bool,
    suffix_similarity: f32,
}

struct FuzzyBlockCandidate<'a> {
    block: &'a DocumentBlock,
    fingerprint_matches: bool,
    heading_similarity: f32,
    offset_distance: usize,
}

impl FuzzyWindow {
    fn window_score(&self) -> f32 {
        self.quote_similarity * 0.72 + self.prefix_similarity * 0.14 + self.suffix_similarity * 0.14
    }
}

struct TextSpan {
    start_byte: usize,
    end_byte: usize,
}

#[derive(Clone)]
struct FootnoteReference {
    label: String,
    occurrence: usize,
    range: ResolvedRange,
}

#[derive(Clone)]
struct FootnoteDefinition {
    label: String,
    occurrence: usize,
    block_range: ResolvedRange,
    block_text: String,
}

struct ScoredStructuredRange {
    range: ResolvedRange,
    score: f32,
}

struct ScoredFootnoteDefinition {
    candidate: FootnoteDefinition,
    score: f32,
}

struct LineInfo<'a> {
    body: &'a str,
    start_byte: usize,
    end_byte: usize,
    start_offset_utf16: usize,
    end_offset_utf16: usize,
}

enum Edge {
    Prefix,
    Suffix,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_match_in_the_same_heading() {
        let original = "# Alpha\n\ntarget phrase\n\n# Beta\n\ntarget phrase\n";
        let updated = "# Beta\n\ntarget phrase\n\n# Alpha\n\ntarget phrase\n";
        let mut anchor = anchor_for(
            original,
            "target phrase",
            "target phrase",
            27,
            39,
            7,
            vec!["Beta".into()],
        );

        reattach_anchor(&mut anchor, updated, &headings(updated));

        assert_eq!(anchor.state, "shifted");
        assert_eq!(anchor.start_line, 3);
        assert!(anchor.confidence >= NEEDS_REVIEW_THRESHOLD);
    }

    #[test]
    fn prefers_the_block_with_the_matching_fingerprint() {
        let prefix = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
        let suffix = " Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
        let block_one = format!(
            "{prefix}target phrase{suffix}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        let block_two = format!(
            "{prefix}target phrase{suffix}BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        );
        let original = format!("# Section\n\n{block_one}\n\n{block_two}\n");
        let updated = format!("# Section\n\n{block_two}\n\n{block_one}\n");
        let anchor_start = original.find("target phrase").expect("quote start");
        let mut anchor = anchor_for(
            original.as_str(),
            &block_one,
            "target phrase",
            anchor_start,
            anchor_start + "target phrase".len(),
            3,
            vec!["Section".into()],
        );

        reattach_anchor(&mut anchor, updated.as_str(), &headings(updated.as_str()));

        let slice = slice_utf16(
            updated.as_str(),
            anchor.start_offset_utf16,
            anchor.end_offset_utf16,
        )
        .expect("updated slice");
        assert_eq!(slice, "target phrase");
        assert_eq!(anchor.state, "shifted");
        assert_eq!(anchor.start_line, 5);
        assert!(anchor.confidence >= 0.7);
    }

    #[test]
    fn recovers_a_fuzzy_range_when_the_quote_changes() {
        let original =
            "# Intro\n\nThe quick brown fox jumps over the lazy dog near the river bank.\n";
        let updated =
            "# Intro\n\nThe quick auburn fox leapt over the lazy dog near the river bank.\n";
        let quote = "brown fox jumps";
        let anchor_start = original.find(quote).expect("quote start");
        let mut anchor = anchor_for(
            original,
            "The quick brown fox jumps over the lazy dog near the river bank.",
            quote,
            anchor_start,
            anchor_start + quote.len(),
            3,
            vec!["Intro".into()],
        );

        reattach_anchor(&mut anchor, updated, &headings(updated));

        let slice = slice_utf16(updated, anchor.start_offset_utf16, anchor.end_offset_utf16)
            .expect("fuzzy slice");
        assert_eq!(anchor.state, "fuzzy");
        assert!(anchor.confidence >= 0.55);
        assert_eq!(slice, "auburn fox leapt");
    }

    #[test]
    fn reattaches_repeated_footnote_references_by_context_and_metadata() {
        let original = "First ref[^a].\nSecond ref[^a].\n\n[^a]: shared note\n";
        let updated = "Inserted line[^a].\nFirst ref[^a].\nSecond ref[^a].\n\n[^a]: shared note\n";
        let anchor_start = original.rfind("[^a]").expect("second footnote ref");
        let mut anchor = anchor_for(
            original,
            "Second ref[^a].",
            "[^a]",
            anchor_start,
            anchor_start + "[^a]".len(),
            2,
            Vec::new(),
        );
        anchor.kind = "footnote_reference".into();
        anchor.footnote = Some(crate::thread::FootnoteAnchorMetadata {
            label: "a".into(),
            occurrence: 2,
        });

        reattach_anchor(&mut anchor, updated, &headings(updated));

        let slice = slice_utf16(updated, anchor.start_offset_utf16, anchor.end_offset_utf16)
            .expect("updated footnote ref");
        assert_eq!(slice, "[^a]");
        assert_eq!(anchor.start_line, 3);
        assert_eq!(anchor.state, "shifted");
        assert!(anchor.confidence >= NEEDS_REVIEW_THRESHOLD);
    }

    #[test]
    fn reattaches_footnote_definition_selections_with_shared_quote_text() {
        let original = concat!(
            "Paragraph[^a] and other[^b].\n\n",
            "[^a]: repeated note\n\n",
            "[^b]: repeated note\n",
        );
        let updated = concat!(
            "Paragraph[^a] and other[^b].\n\n",
            "[^b]: repeated note\n\n",
            "[^a]: repeated note\n",
        );
        let anchor_start = original.rfind("repeated note").expect("definition quote");
        let mut anchor = anchor_for(
            original,
            "[^b]: repeated note",
            "repeated note",
            anchor_start,
            anchor_start + "repeated note".len(),
            5,
            Vec::new(),
        );
        anchor.kind = "footnote_definition".into();
        anchor.footnote = Some(crate::thread::FootnoteAnchorMetadata {
            label: "b".into(),
            occurrence: 1,
        });

        reattach_anchor(&mut anchor, updated, &headings(updated));

        let slice = slice_utf16(updated, anchor.start_offset_utf16, anchor.end_offset_utf16)
            .expect("updated definition slice");
        assert_eq!(slice, "repeated note");
        assert_eq!(anchor.start_line, 3);
        assert_eq!(anchor.state, "shifted");
        assert!(anchor.confidence >= NEEDS_REVIEW_THRESHOLD);
    }

    #[test]
    fn bounds_fuzzy_window_sampling_for_large_blocks() {
        let block = DocumentBlock {
            end_offset_utf16: 10_000,
            fingerprint: "sha256:test".into(),
            heading_path: vec!["Section".into()],
            start_offset_utf16: 0,
            text: String::new(),
        };
        let anchor = AnchorRecord {
            quote: "old paragraph text".into(),
            prefix_context: String::new(),
            suffix_context: String::new(),
            start_offset_utf16: 5_000,
            end_offset_utf16: 5_100,
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 101,
            heading_path: vec!["Section".into()],
            block_fingerprint: "sha256:other".into(),
            base_content_hash: "sha256:base".into(),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        };

        let starts = fuzzy_window_start_indices(&anchor, &block, 5_000, 5);

        assert!(starts.len() < 100);
        assert!(starts.contains(&2_499) || starts.contains(&2_500));
    }

    #[test]
    fn bounds_fuzzy_block_candidates_for_repeated_headings() {
        let mut content = String::from("# Section\n\n");
        for index in 0..96 {
            content.push_str(&format!(
                "Paragraph {index} keeps enough nearby language for fuzzy comparison under one heading.\n\n"
            ));
        }
        let blocks = collect_blocks(&content, &headings(&content));
        let anchor_start = content.find("Paragraph 48").expect("anchor block");
        let anchor = AnchorRecord {
            quote: "edited nearby language".into(),
            prefix_context: String::new(),
            suffix_context: String::new(),
            start_offset_utf16: byte_to_utf16_index(&content, anchor_start),
            end_offset_utf16: byte_to_utf16_index(&content, anchor_start + "Paragraph 48".len()),
            start_line: 99,
            start_column: 1,
            end_line: 99,
            end_column: 13,
            heading_path: vec!["Section".into()],
            block_fingerprint: "sha256:other".into(),
            base_content_hash: "sha256:base".into(),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        };

        let scored = score_fuzzy_block_candidates(&anchor, &content, &blocks);

        assert!(scored.len() <= MAX_FUZZY_BLOCK_CANDIDATES);
    }

    #[test]
    fn long_fuzzy_quotes_use_block_level_window() {
        let original_quote = (0..150)
            .map(|index| format!("original-token-{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let updated_block = (0..220)
            .map(|index| format!("updated-token-{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let content = format!("# Section\n\n{updated_block}\n");
        let block = collect_blocks(&content, &headings(&content))
            .into_iter()
            .find(|entry| entry.text.contains("updated-token-0"))
            .expect("content block");
        let anchor = AnchorRecord {
            quote: original_quote,
            prefix_context: String::new(),
            suffix_context: String::new(),
            start_offset_utf16: block.start_offset_utf16,
            end_offset_utf16: block.end_offset_utf16,
            start_line: 3,
            start_column: 1,
            end_line: 3,
            end_column: 10,
            heading_path: vec!["Section".into()],
            block_fingerprint: "sha256:other".into(),
            base_content_hash: "sha256:base".into(),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        };

        let window =
            best_fuzzy_window_for_block(&anchor, &content, &block).expect("coarse fuzzy window");

        assert_eq!(window.range.start_offset_utf16, block.start_offset_utf16);
        assert_eq!(window.range.end_offset_utf16, block.end_offset_utf16);
    }

    fn headings(content: &str) -> Vec<HeadingIndexEntry> {
        crate::document::extract_heading_index(content)
    }

    fn anchor_for(
        original_content: &str,
        block_text: &str,
        quote: &str,
        start_byte: usize,
        end_byte: usize,
        start_line: usize,
        heading_path: Vec<String>,
    ) -> AnchorRecord {
        let start_offset_utf16 = byte_to_utf16_index(original_content, start_byte);
        let end_offset_utf16 = byte_to_utf16_index(original_content, end_byte);
        let prefix_start_utf16 = start_offset_utf16.saturating_sub(48);
        let suffix_end_utf16 = (end_offset_utf16 + 48).min(original_content.encode_utf16().count());

        AnchorRecord {
            quote: quote.into(),
            prefix_context: slice_utf16(original_content, prefix_start_utf16, start_offset_utf16)
                .expect("prefix context")
                .into(),
            suffix_context: slice_utf16(original_content, end_offset_utf16, suffix_end_utf16)
                .expect("suffix context")
                .into(),
            start_offset_utf16,
            end_offset_utf16,
            start_line,
            start_column: 1,
            end_line: start_line,
            end_column: quote.encode_utf16().count() + 1,
            heading_path,
            block_fingerprint: block_fingerprint(block_text),
            base_content_hash: content_hash(original_content),
            kind: "text_span".into(),
            footnote: None,
            state: "attached".into(),
            confidence: 1.0,
        }
    }
}
