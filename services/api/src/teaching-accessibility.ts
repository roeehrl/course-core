/**
 * Host accessibility check for generated teaching text, run before (and independently of) the
 * course's installed verifier. Deterministic and conservative: it catches what a screen-reader
 * or keyboard learner would lose, never judges content quality. A failure is check feedback the
 * supervisor can repair, never evidence about the learner.
 */
export const ACCESSIBILITY_CHECK_ID = 'host-accessibility';
export type AccessibilityProblem =
  | 'image_without_alt' | 'raw_html' | 'heading_level_skipped' | 'vague_link_text' | 'table_without_header'
  | 'empty_block' | 'color_only_reference' | 'all_caps_text';
const VAGUE_LINK = /\[\s*(click here|here|this|link|this link|read more|more)\s*\]\(/i;
const COLOR_ONLY = /\b(?:the|in|see)\s+(?:red|green|blue|orange|purple|yellow)\s+(?:one|ones|line|lines|box|boxes|part|parts|text|area)\b/i;
export function accessibilityProblems(blocks: readonly string[]): AccessibilityProblem[] {
  const problems = new Set<AccessibilityProblem>();
  let level = 0;
  for (const markdown of blocks) {
    if (!markdown.trim()) problems.add('empty_block');
    if (/!\[\s*\]\(/.test(markdown)) problems.add('image_without_alt');
    if (/<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(markdown)) problems.add('raw_html');
    if (VAGUE_LINK.test(markdown)) problems.add('vague_link_text');
    if (COLOR_ONLY.test(markdown)) problems.add('color_only_reference');
    const lines = markdown.split('\n');
    for (const [i, line] of lines.entries()) {
      const heading = /^(#{1,6})\s+\S/.exec(line);
      if (heading) {
        const next = heading[1]!.length;
        if (level && next > level + 1) problems.add('heading_level_skipped');
        level = next;
      }
      // A table row must be preceded by a header row and a separator row.
      if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
        const previous = lines[i - 1] ?? '', separator = lines[i + 1] ?? '';
        const startsTable = !/^\s*\|.*\|\s*$/.test(previous);
        if (startsTable && !/^\s*\|[\s:|-]+\|\s*$/.test(separator)) problems.add('table_without_header');
      }
      const words = line.match(/\b[A-Z]{4,}\b/g) ?? [];
      if (words.length >= 4) problems.add('all_caps_text');
    }
  }
  return [...problems].sort();
}
