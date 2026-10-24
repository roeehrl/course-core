/**
 * Core's own feedback on a submitted answer, as a wording code and its values. The learner app
 * words it in the reader's language (docs/i18n.md, "The API speaks codes, not prose"); the API
 * never sends Core's sentence. An author's or an extension's explanation stays in `explanation`,
 * in the course's language.
 */
export const ANSWER_MESSAGE_CODES = ['abstained', 'pending_review', 'code_all_matched', 'code_some_matched', 'code_limit'] as const;
export type AnswerMessageCode = typeof ANSWER_MESSAGE_CODES[number];
/** Which sandbox limit stopped a code submission. */
export const CODE_LIMITS = ['time', 'output', 'execution'] as const;
export interface AnswerMessage { code: AnswerMessageCode; params?: Record<string, string | number> }
export function answerMessage(code: AnswerMessageCode, params?: Record<string, string | number>): AnswerMessage {
  return params ? { code, params } : { code };
}
