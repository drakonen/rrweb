/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { maskInputValue } from '../src/utils';

type MaskArguments = Parameters<typeof maskInputValue>[0];

function mask(value: string | null, overrides: Partial<MaskArguments> = {}) {
  return maskInputValue({
    element: document.createElement('input'),
    tagName: 'input',
    type: 'text',
    maskInputOptions: { text: true, maskLengthStrategy: 'bucketed' },
    value,
    ...overrides,
  });
}

describe('maskInputValue fixed placeholders', () => {
  it.each([null, ''])('keeps an empty value (%s) empty', (value) => {
    expect(mask(value)).toBe('');
  });

  it.each([undefined, 'fixed', 'bucketed'] as const)(
    'uses eight characters with strategy %s',
    (maskLengthStrategy) => {
      expect(
        mask('private input', {
          maskInputOptions: { text: true, maskLengthStrategy },
        }),
      ).toBe('********');
    },
  );

  it.each(['input', 'textarea'] as const)(
    'caps the placeholder at the %s maximum length',
    (tagName) => {
      const element = document.createElement(tagName);
      for (const [maxLength, expected] of [
        [0, ''],
        [3, '***'],
        [8, '********'],
        [20, '********'],
      ] as const) {
        element.maxLength = maxLength;
        expect(mask('private input', { element, tagName })).toBe(expected);
      }
    },
  );

  it.each(['a', 'private input', 'a'.repeat(100)])(
    'does not expose the length of %s',
    (value) => expect(mask(value)).toBe('********'),
  );

  it('does not enable masking just by selecting a strategy', () => {
    expect(
      mask('private input', {
        maskInputOptions: { maskLengthStrategy: 'bucketed' },
      }),
    ).toBe('private input');
  });

  it('allows a field type to explicitly disable masking', () => {
    expect(
      mask('private input', {
        maskInputOptions: { text: false, maskLengthStrategy: 'bucketed' },
      }),
    ).toBe('private input');
  });

  it('gives a custom mask function precedence over the length strategy', () => {
    const element = document.createElement('input');
    const maskInputFn = vi.fn(() => '[hidden]');

    expect(mask('private input', { element, maskInputFn })).toBe('[hidden]');
    expect(maskInputFn).toHaveBeenCalledTimes(1);
    expect(maskInputFn).toHaveBeenCalledWith('private input', element);
  });
});
