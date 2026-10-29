/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { getInputKind, InputActivity } from '../../src/record/input-activity';

describe('masked input activity', () => {
  it('emits nothing during edits and an unordered set once per visit', () => {
    const input = document.createElement('input');
    const activity = new InputActivity();
    activity.seed(input, false, true);
    expect(activity.update(input, true, 'insert')).toBeUndefined();
    expect(activity.update(input, true, 'paste')).toBeUndefined();
    expect(activity.update(input, true, 'delete')).toBeUndefined();
    expect(activity.update(input, true, 'insert')).toBeUndefined();
    expect(activity.blur(input)?.inputKinds).toEqual([
      'delete',
      'insert',
      'paste',
    ]);
    expect(activity.blur(input)).toBeUndefined();
    activity.seed(input, true, true);
    expect(activity.update(input, false, 'delete')).toBeUndefined();
    expect(activity.blur(input)?.inputKinds).toEqual(['delete']);
  });

  it('does not emit an edit for prefilled fields or infer kinds from change events', () => {
    const input = document.createElement('input');
    const activity = new InputActivity();
    activity.seed(input, true, true);
    expect(activity.update(input, true, 'insert')).toBeUndefined();
    expect(getInputKind(new Event('change'), input)).toBeUndefined();
  });

  it.each([
    ['insertText', 'insert'],
    ['insertCompositionText', 'insert'],
    ['insertReplacementText', 'insert'],
    ['deleteContentBackward', 'delete'],
    ['deleteByCut', 'delete'],
    ['insertFromPaste', 'paste'],
    ['insertFromDrop', 'paste'],
    ['', 'autofill'],
  ])('maps %s to %s', (inputType, expected) => {
    expect(
      getInputKind(
        new InputEvent('input', { inputType }),
        document.createElement('input'),
      ),
    ).toBe(expected);
  });
});
