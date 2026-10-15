import { describe, expect, it } from 'vitest';
import { accessibilityProblems } from '../src/teaching-accessibility.js';

describe('host accessibility check for generated teaching', () => {
  it('passes plain, structured, accessible text', () => {
    expect(accessibilityProblems(['## Finding a minimum', 'Compare each value with the smallest so far.\n\n### Example\n\n| Value | Smallest so far |\n| --- | --- |\n| 4 | 4 |',
      '![A number line with -3 left of 4](asset:line) See [the ordering guide](https://example.org/ordering).', 'Minimum of [4, -3, 9] is -3.'])).toEqual([]);
  });
  it.each([
    [['![](asset:line)'], 'image_without_alt'],
    [['Use <b>bold</b> here.'], 'raw_html'],
    [['## Title\n#### Too deep'], 'heading_level_skipped'],
    [['Read more [here](https://example.org).'], 'vague_link_text'],
    [['Values:\n| 4 | 5 |\n| 6 | 7 |'], 'table_without_header'],
    [['   '], 'empty_block'],
    [['Look at the red line to see the smallest value.'], 'color_only_reference'],
    [['THIS VALUE MUST ALWAYS BE SMALLER'], 'all_caps_text'],
  ])('flags %j as %s', (blocks, problem) => {
    expect(accessibilityProblems(blocks)).toContain(problem);
  });
  it('reports each problem once, in a stable order, across blocks', () => {
    expect(accessibilityProblems(['![](a)', '<i>x</i>', '![](b)'])).toEqual(['image_without_alt', 'raw_html']);
  });
});
