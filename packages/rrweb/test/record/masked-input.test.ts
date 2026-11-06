/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MouseInteractions } from '@rrweb/types';
import { Mirror, snapshot } from 'rrweb-snapshot';
import {
  initInputObserver,
  initMouseInteractionObserver,
} from '../../src/record/observer';
import type { observerParam } from '../../src/types';
import { serializeMaskedInputState } from '../../src/record/masked-input';

describe('masked input editing sessions', () => {
  let stop: (() => void) | undefined;
  let input: HTMLInputElement;
  let mirror: Mirror;
  let inputCb: ReturnType<typeof vi.fn>;
  let mouseInteractionCb: ReturnType<typeof vi.fn>;
  let listeners: Map<string, EventListener>;
  let setValue: (this: HTMLInputElement, value: string) => void;

  beforeEach(() => {
    document.body.innerHTML = '<input type="text"><textarea></textarea>';
    input = document.querySelector('input')!;
    mirror = new Mirror();
    snapshot(document, { mirror });
    inputCb = vi.fn();
    mouseInteractionCb = vi.fn();
    listeners = new Map();
    setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function observe(overrides: Partial<observerParam> = {}) {
    const addListener = vi.spyOn(document, 'addEventListener');
    stop = initInputObserver({
      doc: document,
      mirror,
      inputCb,
      mouseInteractionCb,
      blockClass: 'rr-block',
      ignoreClass: 'rr-ignore',
      maskInputOptions: { text: true, textarea: true },
      sampling: {},
      ...overrides,
    } as observerParam);
    for (const [type, listener] of addListener.mock.calls) {
      listeners.set(type, listener as EventListener);
    }
  }

  // Exercise the registered listener with trusted event metadata. DOM-created
  // events cannot be trusted, so ordinary dispatchEvent is tested separately.
  function edit(target: HTMLElement = input, type = 'input') {
    listeners.get(type)!({
      type,
      target,
      isTrusted: true,
      composedPath: () => [target],
    } as unknown as Event);
  }

  it('emits start and blur even when the masked value is identical', () => {
    observe({ userTriggeredOnInput: true });
    input.focus();
    expect(inputCb).not.toHaveBeenCalled();
    setValue.call(input, 'a');
    edit();
    expect(inputCb).toHaveBeenLastCalledWith({
      id: mirror.getId(input),
      text: '********',
      isChecked: false,
      userTriggered: true,
    });
    setValue.call(input, 'a much longer secret');
    edit();
    edit(input, 'change');
    expect(inputCb).toHaveBeenCalledTimes(1);
    input.blur();
    expect(inputCb).toHaveBeenCalledTimes(2);
    expect(inputCb.mock.calls[1][0]).toEqual({
      id: mirror.getId(input),
      text: '********',
      isChecked: false,
      userTriggered: true,
    });
    expect(mouseInteractionCb.mock.calls.map(([data]) => data)).toEqual([
      {
        id: mirror.getId(input),
        type: MouseInteractions.Focus,
        maskFocus: true,
      },
      { id: mirror.getId(input), type: MouseInteractions.Blur, maskBlur: true },
    ]);
    for (const [data] of inputCb.mock.calls) {
      expect(data).not.toHaveProperty('maskFocus');
      expect(data).not.toHaveProperty('maskBlur');
    }
  });

  it('records one masked blur interaction after the final input value', () => {
    const stopMouse = initMouseInteractionObserver({
      doc: document,
      mirror,
      mouseInteractionCb,
      sampling: {},
      blockClass: 'rr-block',
    } as observerParam);
    try {
      observe();
      input.focus();
      setValue.call(input, 'secret');
      edit();
      input.blur();
      const interactions = mouseInteractionCb.mock.calls.map(([data]) => data);
      expect(interactions).toEqual([
        expect.objectContaining({ type: MouseInteractions.Focus }),
        {
          id: mirror.getId(input),
          type: MouseInteractions.Focus,
          maskFocus: true,
        },
        {
          id: mirror.getId(input),
          type: MouseInteractions.Blur,
          maskBlur: true,
        },
      ]);
      expect(mouseInteractionCb.mock.invocationCallOrder[2]).toBeGreaterThan(
        inputCb.mock.invocationCallOrder[1],
      );
    } finally {
      stopMouse();
    }
  });

  it('records a cleared value only at the end and starts another edit', () => {
    observe();
    input.focus();
    setValue.call(input, 'secret');
    edit();
    setValue.call(input, '');
    edit();
    input.blur();
    expect(inputCb.mock.calls.map(([v]) => v)).toEqual([
      expect.objectContaining({ text: '********' }),
      expect.objectContaining({ text: '' }),
    ]);
    input.focus();
    setValue.call(input, 'new secret');
    edit();
    expect(mouseInteractionCb.mock.calls[2][0].maskFocus).toBe(true);
  });

  it('does not start an edit for focus or synthetic input', () => {
    observe();
    input.focus();
    input.blur();
    expect(inputCb).not.toHaveBeenCalled();
    setValue.call(input, 'secret');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(inputCb).toHaveBeenCalledTimes(1);
    expect(inputCb).toHaveBeenCalledWith({
      id: mirror.getId(input),
      text: '********',
      isChecked: false,
    });
  });

  it('preserves programmatic updates without starting an edit', async () => {
    observe();
    input.value = 'secret';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inputCb).toHaveBeenCalledTimes(1);
    expect(inputCb).toHaveBeenCalledWith({
      id: mirror.getId(input),
      text: '********',
      isChecked: false,
    });
  });

  it('honors maxLength and custom mask functions', () => {
    observe({ maskInputFn: () => '[hidden]' });
    input.maxLength = 3;
    input.focus();
    setValue.call(input, 'abc');
    edit();
    expect(inputCb.mock.calls[0][0].text).toBe('[hidden]');
    input.blur();
    expect(inputCb.mock.calls[1][0].text).toBe('[hidden]');
  });

  it('masks only emitted values while unrelated fields still record', () => {
    const maskInputFn = vi.fn(() => '[hidden]');
    const ordinary = document.createElement('input');
    ordinary.type = 'search';
    document.body.appendChild(ordinary);
    snapshot(document, { mirror });
    observe({ maskInputFn });
    input.focus();
    setValue.call(input, 'private initial');
    edit();
    setValue.call(input, 'private updated');
    edit();
    edit(input, 'change');
    expect(maskInputFn).toHaveBeenCalledTimes(1);
    input.blur();
    expect(maskInputFn).toHaveBeenCalledTimes(2);
    ordinary.focus();
    setValue.call(ordinary, 'public');
    edit(ordinary);
    expect(inputCb.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ text: '[hidden]' }),
      expect.objectContaining({ text: '[hidden]' }),
      expect.objectContaining({ id: mirror.getId(ordinary), text: 'public' }),
    ]);
    expect(JSON.stringify(inputCb.mock.calls)).not.toContain('private');
  });

  it('keeps change-only sampling to a single final event', () => {
    observe({ sampling: { input: 'last' } });
    expect(listeners.has('input')).toBe(false);
    input.focus();
    setValue.call(input, 'secret');
    edit(input, 'change');
    input.blur();
    expect(inputCb).toHaveBeenCalledTimes(1);
    expect(inputCb).toHaveBeenCalledWith({
      id: mirror.getId(input),
      text: '********',
      isChecked: false,
    });
    expect(mouseInteractionCb.mock.calls.map(([data]) => data)).toEqual([
      { id: mirror.getId(input), type: MouseInteractions.Blur, maskBlur: true },
    ]);
  });

  it('flags a trusted final change even when focus has already moved', () => {
    observe({ sampling: { input: 'last' } });
    input.focus();
    setValue.call(input, 'secret');
    input.blur();
    edit(input, 'change');
    expect(inputCb).toHaveBeenCalledTimes(1);
    expect(mouseInteractionCb.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: MouseInteractions.Blur, maskBlur: true }),
    );
  });

  it('does not read intermediate values during an active edit', () => {
    observe();
    input.focus();
    setValue.call(input, 'secret');
    const read = vi.spyOn(input, 'value', 'get');
    edit();
    edit();
    edit(input, 'change');
    expect(read).toHaveBeenCalledTimes(1);
    input.blur();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('handles textareas inside a shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const textarea = document.createElement('textarea');
    root.appendChild(textarea);
    snapshot(document, { mirror });
    observe();
    textarea.focus();
    textarea.value = 'secret';
    edit(textarea);
    textarea.blur();
    expect(mouseInteractionCb.mock.calls.map(([v]) => v)).toEqual([
      expect.objectContaining({ maskFocus: true }),
      expect.objectContaining({ maskBlur: true }),
    ]);
  });

  it('leaves unmasked input deduplication unchanged', () => {
    observe({ maskInputOptions: {} });
    input.focus();
    setValue.call(input, 'a');
    edit();
    edit();
    setValue.call(input, 'ab');
    edit();
    input.blur();
    expect(inputCb.mock.calls.map(([v]) => v)).toEqual([
      { id: mirror.getId(input), text: 'a', isChecked: false },
      { id: mirror.getId(input), text: 'ab', isChecked: false },
    ]);
  });

  it.each(['rr-block', 'rr-ignore'])(
    'contains %s input while ordinary input recording survives',
    (className) => {
      const ordinary = document.createElement('input');
      document.body.appendChild(ordinary);
      snapshot(document, { mirror });
      observe({ maskInputOptions: {} });
      input.className = className;
      input.focus();
      setValue.call(input, 'private-value-must-not-escape');
      edit();
      input.blur();
      ordinary.focus();
      setValue.call(ordinary, 'readable public value');
      edit(ordinary);
      ordinary.blur();

      const recorded = inputCb.mock.calls.map(([value]) => value);
      expect(JSON.stringify(recorded)).not.toContain(
        'private-value-must-not-escape',
      );
      expect(recorded).toEqual([
        {
          id: mirror.getId(ordinary),
          text: 'readable public value',
          isChecked: false,
        },
      ]);
    },
  );

  it('preserves a programmatic clear and unrelated edits after removal without blur', async () => {
    vi.useFakeTimers();
    const ordinary = document.createElement('input');
    ordinary.type = 'search';
    document.body.appendChild(ordinary);
    snapshot(document, { mirror });
    observe();
    input.focus();
    setValue.call(input, 'private-value-must-not-escape');
    edit();
    input.remove();
    document.body.appendChild(input);
    expect(document.activeElement).not.toBe(input);
    const checkout = snapshot(document, {
      mirror,
      maskAllInputs: { text: true },
      onSerialize: (node) => serializeMaskedInputState(node, mirror),
    });
    expect(JSON.stringify(checkout)).not.toContain('data-rrweb-masked-editing');
    expect(JSON.stringify(checkout)).not.toContain(
      'private-value-must-not-escape',
    );
    input.value = '';
    await vi.runAllTimersAsync();
    ordinary.focus();
    setValue.call(ordinary, 'continued useful work');
    edit(ordinary);
    ordinary.blur();

    const recorded = inputCb.mock.calls.map(([value]) => value);
    expect(JSON.stringify(recorded)).not.toContain(
      'private-value-must-not-escape',
    );
    expect(recorded).toContainEqual(
      expect.objectContaining({
        id: mirror.getId(ordinary),
        text: 'continued useful work',
      }),
    );
    expect(recorded).toContainEqual(
      expect.objectContaining({
        id: mirror.getId(input),
        text: '',
      }),
    );
  });

  it('serializes an active session without modifying the recorded element', () => {
    observe();
    input.focus();
    setValue.call(input, 'private');
    edit();
    const checkout = snapshot(document, {
      mirror,
      maskAllInputs: { text: true },
      onSerialize: (node) => serializeMaskedInputState(node, mirror),
    });
    expect(input.hasAttribute('data-rrweb-masked-editing')).toBe(false);
    expect(JSON.stringify(checkout)).toContain('data-rrweb-masked-editing');
    input.blur();
    snapshot(document, {
      mirror,
      onSerialize: (node) => serializeMaskedInputState(node, mirror),
    });
    expect(mirror.getMeta(input)).toEqual(
      expect.objectContaining({
        attributes: expect.not.objectContaining({
          'data-rrweb-masked-editing': 'true',
        }),
      }),
    );
  });

  it('removes listeners when recording stops during an edit', () => {
    observe();
    input.focus();
    setValue.call(input, 'secret');
    edit();
    stop!();
    stop = undefined;
    input.blur();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(inputCb).toHaveBeenCalledTimes(1);
  });

  it('ignores a pending setter callback after recording stops', async () => {
    observe();
    input.value = 'secret';
    stop!();
    stop = undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inputCb).not.toHaveBeenCalled();
  });

  it('starts fresh when a removed field is reinserted and focused', () => {
    observe();
    input.focus();
    setValue.call(input, 'secret');
    edit();
    input.remove();
    document.body.appendChild(input);
    input.focus();
    edit();
    input.blur();
    expect(mouseInteractionCb.mock.calls.map(([v]) => v)).toEqual([
      expect.objectContaining({ maskFocus: true }),
      expect.objectContaining({ maskFocus: true }),
      expect.objectContaining({ maskBlur: true }),
    ]);
  });
});
