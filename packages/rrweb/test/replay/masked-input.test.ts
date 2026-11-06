/**
 * @vitest-environment jsdom
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Mirror, snapshot } from 'rrweb-snapshot';
import {
  EventType,
  IncrementalSource,
  MouseInteractions,
  ReplayerEvents,
  type eventWithTime,
} from '@rrweb/types';
import { Replayer } from '../../src/replay';
import { initInputObserver } from '../../src/record/observer';
import type { observerParam } from '../../src/types';

describe('masked input replay', () => {
  let replayer: Replayer | undefined;
  const sandboxDescriptor = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    'sandbox',
  );

  beforeAll(() => {
    // jsdom does not implement the sandbox DOMTokenList API.
    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
      configurable: true,
      get() {
        return (this.getAttribute('sandbox') || '')
          .split(/\s+/)
          .filter(Boolean);
      },
    });
  });

  afterAll(() => {
    if (sandboxDescriptor) {
      Object.defineProperty(
        HTMLIFrameElement.prototype,
        'sandbox',
        sandboxDescriptor,
      );
    } else {
      delete (HTMLIFrameElement.prototype as Partial<HTMLIFrameElement>)
        .sandbox;
    }
  });

  afterEach(() => {
    replayer?.destroy();
    document.body.innerHTML = '';
  });

  it('contains secrets while snapshots and input events remain usable in replay', () => {
    document.body.innerHTML = '<input type="password"><input type="text">';
    const [secret, ordinary] = Array.from(document.querySelectorAll('input'));
    secret.value = 'private-initial-secret';
    ordinary.value = 'initial public value';
    const mirror = new Mirror();
    const maskInputOptions = { password: true };
    const node = snapshot(document, {
      mirror,
      maskAllInputs: maskInputOptions,
    })!;
    const events: eventWithTime[] = [
      {
        type: EventType.Meta,
        timestamp: 1000,
        data: { href: 'https://example.com', width: 800, height: 600 },
      },
      {
        type: EventType.FullSnapshot,
        timestamp: 1001,
        data: { node, initialOffset: { top: 0, left: 0 } },
      },
    ];
    // Bypass the asynchronous setter hook: these dispatched input events are
    // the operation under test, not duplicate setter notifications.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    const stop = initInputObserver({
      doc: document,
      mirror,
      maskInputOptions,
      sampling: {},
      blockClass: 'rr-block',
      ignoreClass: 'rr-ignore',
      inputCb: (data) =>
        events.push({
          type: EventType.IncrementalSnapshot,
          timestamp: 1010 + events.length,
          data: { source: IncrementalSource.Input, ...data },
        }),
    } as observerParam);
    try {
      setValue.call(secret, 'private-updated-secret');
      secret.dispatchEvent(new Event('input', { bubbles: true }));
      setValue.call(ordinary, 'updated public value');
      ordinary.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      stop();
    }
    events.push({ type: EventType.Load, timestamp: 1030, data: {} });
    expect(JSON.stringify(events)).not.toContain('private-initial-secret');
    expect(JSON.stringify(events)).not.toContain('private-updated-secret');
    expect(
      events.filter((event) => event.type === EventType.IncrementalSnapshot),
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          id: mirror.getId(secret),
          text: '********',
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          id: mirror.getId(ordinary),
          text: 'updated public value',
        }),
      }),
    ]);

    replayer = new Replayer(events);
    replayer.iframe.contentWindow!.scrollTo = vi.fn();
    const replayValue = (element: HTMLInputElement) =>
      (replayer!.getMirror().getNode(mirror.getId(element)) as HTMLInputElement)
        .value;
    replayer.pause(5);
    expect(replayValue(secret)).toBe('********');
    expect(replayValue(ordinary)).toBe('initial public value');
    replayer.pause(20);
    expect(replayValue(secret)).toBe('********');
    expect(replayValue(ordinary)).toBe('updated public value');
    expect(
      replayer.iframe.contentDocument!.documentElement.outerHTML,
    ).not.toContain('private-');
  });

  it('retains both transition notifications when seeking coalesces input values', () => {
    document.body.innerHTML = '<input type="text">';
    const mirror = new Mirror();
    const node = snapshot(document, { mirror })!;
    const id = mirror.getId(document.querySelector('input')!);
    const focus = {
      source: IncrementalSource.MouseInteraction as const,
      type: MouseInteractions.Focus,
      id,
      maskFocus: true,
    };
    const blur = {
      source: IncrementalSource.MouseInteraction as const,
      type: MouseInteractions.Blur,
      id,
      maskBlur: true,
    };
    replayer = new Replayer([
      {
        type: EventType.Meta,
        timestamp: 1000,
        data: { href: 'https://example.com', width: 800, height: 600 },
      },
      {
        type: EventType.FullSnapshot,
        timestamp: 1001,
        data: { node, initialOffset: { top: 0, left: 0 } },
      },
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 1009,
        data: {
          source: IncrementalSource.Mutation,
          adds: [],
          removes: [],
          texts: [],
          attributes: [{ id, attributes: { title: 'seeking' } }],
        },
      },
      { type: EventType.IncrementalSnapshot, timestamp: 1010, data: focus },
      { type: EventType.IncrementalSnapshot, timestamp: 1020, data: blur },
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 1022,
        data: {
          source: IncrementalSource.Input,
          id,
          text: '',
          isChecked: false,
        },
      },
      { type: EventType.Load, timestamp: 1030, data: {} },
    ]);
    replayer.iframe.contentWindow!.scrollTo = vi.fn();
    const onEdit = vi.fn((data) => {
      expect(data.target.isConnected).toBe(true);
      expect(data.target.value).toBe('');
      expect(data.target.hasAttribute('data-rrweb-masked-editing')).toBe(false);
    });
    replayer.on(ReplayerEvents.MaskedInput, onEdit);
    replayer.pause(25);
    const target = replayer.getMirror().getNode(id);
    expect(onEdit.mock.calls.map(([data]) => data)).toEqual([
      { ...focus, target },
      { ...blur, target },
    ]);
  });

  it.each([false, true])(
    'restores editing state when seeking with virtual DOM %s',
    (useVirtualDom) => {
      document.body.innerHTML = '<input type="text">';
      const mirror = new Mirror();
      const node = snapshot(document, { mirror })!;
      const id = mirror.getId(document.querySelector('input')!);
      document.querySelector('input')!.value = '********';
      document
        .querySelector('input')!
        .setAttribute('data-rrweb-masked-editing', 'true');
      const checkout = snapshot(document, { mirror })!;
      const events: eventWithTime[] = [
        {
          type: EventType.Meta,
          timestamp: 1000,
          data: { href: 'https://example.com', width: 800, height: 600 },
        },
        {
          type: EventType.FullSnapshot,
          timestamp: 1001,
          data: { node, initialOffset: { top: 0, left: 0 } },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1006,
          data: {
            source: IncrementalSource.Input,
            id,
            text: 'legacy',
            isChecked: false,
          },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1009,
          data: {
            source: IncrementalSource.Mutation,
            adds: [],
            removes: [],
            texts: [],
            attributes: [{ id, attributes: { title: 'before editing' } }],
          },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1010,
          data: {
            source: IncrementalSource.Input,
            id,
            text: '********',
            isChecked: false,
          },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1010,
          data: {
            source: IncrementalSource.MouseInteraction,
            type: MouseInteractions.Focus,
            id,
            maskFocus: true,
          },
        },
        {
          type: EventType.FullSnapshot,
          timestamp: 1016,
          data: { node: checkout, initialOffset: { top: 0, left: 0 } },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1019,
          data: {
            source: IncrementalSource.Mutation,
            adds: [],
            removes: [],
            texts: [],
            attributes: [{ id, attributes: { title: 'after checkout' } }],
          },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1020,
          data: {
            source: IncrementalSource.Input,
            id,
            text: '********',
            isChecked: false,
          },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1020,
          data: {
            source: IncrementalSource.MouseInteraction,
            type: MouseInteractions.Blur,
            id,
            maskBlur: true,
          },
        },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1022,
          data: {
            source: IncrementalSource.Input,
            id,
            text: '',
            isChecked: false,
          },
        },
        { type: EventType.Load, timestamp: 1030, data: {} },
      ];
      replayer = new Replayer(events, { useVirtualDom });
      replayer.iframe.contentWindow!.scrollTo = vi.fn();
      const onEdit = vi.fn();
      replayer.on(ReplayerEvents.MaskedInput, onEdit);

      replayer.pause(8);
      let input = replayer.getMirror().getNode(id) as HTMLInputElement;
      expect(input.value).toBe('legacy');
      expect(input.hasAttribute('data-rrweb-masked-editing')).toBe(false);
      expect(onEdit).not.toHaveBeenCalled();

      replayer.pause(15);
      input = replayer.getMirror().getNode(id) as HTMLInputElement;
      expect(input.value).toBe('********');
      expect(input.getAttribute('data-rrweb-masked-editing')).toBe('true');
      expect(onEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({ id, target: input, maskFocus: true }),
      );

      replayer.pause(18);
      input = replayer.getMirror().getNode(id) as HTMLInputElement;
      expect(input.getAttribute('data-rrweb-masked-editing')).toBe('true');

      replayer.pause(25);
      input = replayer.getMirror().getNode(id) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.title).toBe('after checkout');
      expect(input.hasAttribute('data-rrweb-masked-editing')).toBe(false);
      expect(onEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id,
          target: input,
          source: IncrementalSource.MouseInteraction,
          type: MouseInteractions.Blur,
          maskBlur: true,
        }),
      );
      expect(onEdit).toHaveBeenCalledTimes(2);

      replayer.pause(5);
      input = replayer.getMirror().getNode(id) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.hasAttribute('data-rrweb-masked-editing')).toBe(false);

      replayer.pause(15);
      input = replayer.getMirror().getNode(id) as HTMLInputElement;
      expect(input.getAttribute('data-rrweb-masked-editing')).toBe('true');
    },
  );
});
