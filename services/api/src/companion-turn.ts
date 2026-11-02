/**
 * What a companion reply does in the conversation, decided by Core from the stored text (never by
 * the model's say-so). It shapes how the learner's app shows the reply, nothing else.
 *
 * `replyAsksLearner`: the reply ends by asking the learner something. True when the last
 * non-empty paragraph outside code ends with a question mark (`?`, or the Arabic-script `؟`),
 * ignoring closing quotes, brackets and emphasis marks after it. Core's own coaching that stands in
 * for a withheld answer always asks the learner to try a step, so it counts as asking.
 */
export function replyAsksLearner(text: string, { withheld = false }: { withheld?: boolean } = {}): boolean {
  if (withheld) return true;
  const prose = text
    // Fenced code blocks (``` or ~~~), then indented code lines, say nothing about asking.
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '\n')
    .replace(/^(?: {4}|\t)[^\n]*$/gm, '');
  const paragraphs = prose.split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return false;
  const end = last.replace(/[\s"'”’»)\]}*_`>]+$/u, '');
  return /[?؟]$/u.test(end);
}
