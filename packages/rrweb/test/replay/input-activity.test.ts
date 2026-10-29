import { describe, expect, it } from 'vitest';
import { EventType, IncrementalSource, MouseInteractions } from '@rrweb/types';
import type { eventWithTime, inputData } from '@rrweb/types';
import { InputActivityReplay } from '../../src/replay/input-activity';

const summary: inputData = {
  source: IncrementalSource.Input,
  id: 1,
  text: '********',
  isChecked: false,
  masked: true,
  inputKinds: ['insert'],
};

describe('masked input replay', () => {
  it('adds dots from focus time, caps at eight, and applies the final value on blur', () => {
    const replay = new InputActivityReplay();
    replay.focus(1, 100, summary);
    expect(replay.value(1, 100)).toBe('•');
    expect(replay.value(1, 1099)).toBe('•');
    expect(replay.value(1, 1100)).toBe('••');
    expect(replay.value(1, 20_000)).toBe('•'.repeat(8));
    replay.blur(1);
    replay.input({ ...summary, text: '' });
    expect(replay.value(1, 30_000)).toBe('');
    expect(replay.needsAnimation(30_000)).toBe(false);
  });

  it.each(['paste', 'autofill'] as const)(
    'shows a visit containing %s immediately',
    (kind) => {
      const replay = new InputActivityReplay();
      replay.focus(1, 100, { ...summary, inputKinds: [kind] });
      expect(replay.value(1, 100)).toBe('•'.repeat(8));
      expect(replay.needsAnimation(100)).toBe(false);
    },
  );

  it('does not animate visits without a summary or edits', () => {
    const replay = new InputActivityReplay();
    replay.focus(1, 100);
    expect(replay.value(1, 5000)).toBeUndefined();
    replay.focus(1, 100, { ...summary, inputKinds: [] });
    expect(replay.value(1, 5000)).toBeUndefined();
    // Live replay receives only the final state when the summary arrives.
    replay.input(summary);
    expect(replay.value(1, 5000)).toBe('•'.repeat(8));
  });

  it('restores an active visit when seeking past a snapshot checkpoint', () => {
    const replay = new InputActivityReplay();
    const focus: eventWithTime = {
      type: EventType.IncrementalSnapshot,
      timestamp: 100,
      data: {
        source: IncrementalSource.MouseInteraction,
        type: MouseInteractions.Focus,
        id: 1,
        x: 0,
        y: 0,
      },
    };
    const end: eventWithTime = {
      type: EventType.IncrementalSnapshot,
      timestamp: 5000,
      data: summary,
    };
    replay.restore(2500, [focus, end]);
    expect(replay.value(1, 3100)).toBe('••••');
    replay.restore(6000, [focus, end]);
    expect(replay.value(1, 6000)).toBeUndefined();
  });

  it('associates summaries with their own focus visit and supports backward seeks', () => {
    const replay = new InputActivityReplay();
    const focus: eventWithTime = {
      type: EventType.IncrementalSnapshot,
      timestamp: 100,
      data: {
        source: IncrementalSource.MouseInteraction,
        type: MouseInteractions.Focus,
        id: 1,
        x: 0,
        y: 0,
      },
    };
    const end: eventWithTime = {
      type: EventType.IncrementalSnapshot,
      timestamp: 2500,
      data: summary,
    };
    const nextFocus = { ...focus, timestamp: 3000 };
    const events = [focus, end, nextFocus];
    expect(replay.summaryFor(nextFocus, events)).toBeUndefined();
    replay.focus(1, 100, replay.summaryFor(focus, events));
    const expected = replay.value(1, 2100);
    replay.reset();
    expect(replay.value(1, 2100)).toBeUndefined();
    replay.focus(1, 100, replay.summaryFor(focus, events));
    expect(replay.value(1, 2100)).toBe(expected);
    replay.input({ ...summary, masked: undefined, text: 'legacy' });
    expect(replay.value(1, 4000)).toBeUndefined();
  });
});
