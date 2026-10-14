import { toVisualExperience, type Scene } from '@course-core/visuals/headless';
import type { CourseManifest } from '@course-core/sdk';
import { fixture } from './fixture.js';

/** One public synthetic visual of about 36 KB whose renderer check costs about as much as a
 * real lesson overlay: 64 shapes with nested state-driven expressions and an animated timeline. */
export function largeVisual(index: number) {
  const scaled = (factor: number): unknown => ({ op: 'add', args: [{ op: 'mul', args: [{ state: 'amount' }, factor] },
    { op: 'if', args: [{ op: 'eq', args: [{ state: 'mode' }, 'square'] }, { op: 'mul', args: [{ state: 'amount' }, { state: 'amount' }] }, factor] }] });
  const nodes = Array.from({ length: 64 }, (_, n) => ({ kind: 'rect', id: `bar-${n}`, x: 2 + (n % 32) * 9, y: 10 + Math.floor(n / 32) * 40,
    width: { op: 'min', args: [6, scaled(0.1 + n / 200)] }, height: { op: 'min', args: [30, scaled(1 + n / 50)] }, fill: n % 2 ? '#087665' : '#19383E' }));
  const scene = {
    version: 1, id: `study-${index}`, title: `Measured change ${index}`,
    description: 'Adjust the amount, choose a rule, and move through time.',
    state: {
      amount: { kind: 'number', label: 'Amount', initial: 2, min: 0, max: 10, step: 0.5 },
      mode: { kind: 'enum', label: 'Rule', initial: 'linear', options: ['linear', 'square'] },
    },
    controls: ['amount', 'mode'],
    nodes,
    layouts: { compact: { width: 320, height: 160 }, expanded: { width: 480, height: 160 }, breakpoint: 500 },
    timeline: { durationMs: 2000, tracks: nodes.slice(0, 32).map((node, n) => ({ node: node.id, property: 'y', keyframes: [{ atMs: 0, value: node.y }, { atMs: 1000 + n, value: node.y + 5 }, { atMs: 2000, value: node.y }] })),
      cues: [{ atMs: 0, text: 'Observe the starting value.' }, { atMs: 1000, text: 'Explore the second half.' }] },
    accessibility: { text: 'Bars grow with the amount under a linear or square rule. Movement encodes timeline position, not credit.', reducedMotion: { atMs: 1500, description: 'Read the bar heights at a still frame.' } },
    referenceChecks: [],
  } as unknown as Scene;
  return toVisualExperience(scene);
}

/** A public synthetic course of about 2 MB with `visuals` visual blocks, shaped like a large
 * real course: many overlays plus long reading text. */
export function largeCourse(id: string, renderer: { version: string; integrity: string }, visuals = 40): CourseManifest {
  const course = fixture();
  course.id = id;
  const episode = course.chapters[0]!.episodes[0]!;
  for (let i = 0; i < visuals; i++) {
    const visual = largeVisual(i);
    course.visuals.push(visual);
    episode.blocks.push({ id: `diagram-${i}`, type: 'visual', visualId: visual.id });
  }
  const filler = 'Compare each value with every other member of the set before naming the maximum. '.repeat(20);
  for (let i = 0; i < 240; i++) course.chapters[0]!.episodes[1]!.blocks.push({ id: `reading-${i}`, type: 'text', markdown: `${i + 1}. ${filler}` });
  course.extensions.push({ id: 'course-core-svg-v1', version: renderer.version, integrity: renderer.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js', platforms: ['web'],
    capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Interactive bar charts with text alternatives.' } });
  return course;
}
