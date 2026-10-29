import type * as puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { EventType, IncrementalSource, MouseInteractions } from '@rrweb/types';
import type { eventWithTime, inputData } from '@rrweb/types';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { browserClientRecordOptions } from '../src';
import { getServerURL, launchPuppeteer, startServer } from './utils';

interface IWindow extends Window {
  rrwebBrowserClient: { start(options: browserClientRecordOptions): void };
  emit(event: eventWithTime): void;
}

function setup(html: string) {
  const ctx = {
    page: undefined as unknown as puppeteer.Page,
    events: [] as eventWithTime[],
    serverUrl: '',
  };
  let server: Awaited<ReturnType<typeof startServer>>;
  let browser: puppeteer.Browser;

  beforeAll(async () => {
    server = await startServer();
    ctx.serverUrl = getServerURL(server);
    browser = await launchPuppeteer();
  });

  beforeEach(async () => {
    ctx.events = [];
    ctx.page = await browser.newPage();
    await ctx.page.setRequestInterception(true);
    ctx.page.on('request', (request) => {
      if (request.url().includes('/recordings/')) {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        });
      } else {
        void request.continue();
      }
    });
    await ctx.page.goto(ctx.serverUrl);
    await ctx.page.setContent(html);
    await ctx.page.addScriptTag({
      url: `${ctx.serverUrl}/browser-client.umd.cjs`,
    });
    await ctx.page.exposeFunction('emit', (event: eventWithTime) => {
      ctx.events.push(event);
    });
  });

  afterEach(async () => {
    await ctx.page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  return ctx;
}

async function waitForRAF(page: puppeteer.Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

describe('masked input activity', () => {
  const ctx = setup(`
    <!DOCTYPE html>
    <html>
      <body>
        <input type="text" id="test" />
      </body>
    </html>
  `);

  async function start(options: Partial<browserClientRecordOptions> = {}) {
    await ctx.page.evaluate(
      ({ serverUrl, options }) => {
        const { rrwebBrowserClient, emit } = window as unknown as IWindow;
        rrwebBrowserClient.start({
          emit,
          serverUrl: `${serverUrl}/recordings/{recordingId}/events`,
          publicApiKey: 'test-key',
          ...options,
        });
      },
      { serverUrl: ctx.serverUrl, options },
    );
    await waitForRAF(ctx.page);
  }

  async function blur() {
    await ctx.page.$eval('#test', (element) =>
      (element as HTMLInputElement).blur(),
    );
    await waitForRAF(ctx.page);
  }

  it('emits no input events while typing or deleting, and one summary on the next blur', async () => {
    await start();
    await ctx.page.type('#test', 'private input');
    for (let i = 0; i < 13; i++) {
      await ctx.page.keyboard.press('Backspace');
      await waitForRAF(ctx.page);
    }
    expect(inputEvents(ctx.events)).toEqual([]);
    await blur();
    expect(inputEvents(ctx.events)).toMatchObject([
      { text: '', masked: true, inputKinds: ['delete', 'insert'] },
    ]);
    expect(inputEvents(ctx.events)).toHaveLength(1);
    expect(inputEvents(ctx.events)[0]).not.toHaveProperty('inputKind');
  });

  it.each(['insertFromPaste', ''])(
    'aggregates inputType %j until blur and resets the visit summary',
    async (inputType) => {
      await start();
      await ctx.page.click('#test');
      await ctx.page.$eval(
        '#test',
        (element, inputType) => {
          const input = element as HTMLInputElement;
          input.value = 'private value of any length';
          input.dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType }),
          );
        },
        inputType,
      );
      await waitForRAF(ctx.page);
      expect(inputEvents(ctx.events)).toEqual([]);
      await blur();
      const kind = inputType ? 'paste' : 'autofill';
      expect(inputEvents(ctx.events)).toMatchObject([
        { text: '********', inputKinds: [kind] },
      ]);
      await ctx.page.focus('#test');
      await ctx.page.type('#test', 'x');
      await blur();
      expect(inputEvents(ctx.events)).toHaveLength(2);
      expect(inputEvents(ctx.events)[1].inputKinds).toEqual(['insert']);
    },
  );

  it.each([true, false])(
    'replays synthetic dots when seeking with virtual DOM %s',
    async (useVirtualDom) => {
      await start();
      await ctx.page.type('#test', 'x');
      await blur();
      const meta = ctx.events.find((event) => event.type === EventType.Meta)!;
      const snapshot = ctx.events.find(
        (event) => event.type === EventType.FullSnapshot,
      )!;
      const summary = inputEvents(ctx.events)[0];
      const events: eventWithTime[] = [
        { ...meta, timestamp: 0 },
        { ...snapshot, timestamp: 1 },
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 100,
          data: {
            source: IncrementalSource.MouseInteraction,
            type: MouseInteractions.Focus,
            id: summary.id,
            x: 0,
            y: 0,
          },
        },
        { type: EventType.IncrementalSnapshot, timestamp: 5200, data: summary },
        {
          type: EventType.Custom,
          timestamp: 10000,
          data: { tag: 'end', payload: {} },
        },
      ];
      await ctx.page.addScriptTag({
        path: resolve(__dirname, '../../rrweb/dist/rrweb.umd.cjs'),
      });
      const result = await ctx.page.evaluate(
        async ({ events, useVirtualDom, id }) => {
          const replay = new (window as any).rrweb.Replayer(events, {
            useVirtualDom,
            mouseTail: false,
          });
          const values: string[] = [];
          for (const offset of [201, 3200, 7000, 1200]) {
            replay.pause(offset);
            values.push(replay.getMirror().getNode(id).value);
          }
          replay.setConfig({ speed: 10 });
          replay.play(100);
          await new Promise<void>((resolve) => {
            const check = () => {
              if (replay.getCurrentTime() >= 2100) resolve();
              else requestAnimationFrame(check);
            };
            check();
          });
          replay.pause();
          const pausedTime = replay.getCurrentTime();
          const pausedValue = replay.getMirror().getNode(id).value;
          await new Promise((resolve) => setTimeout(resolve, 50));
          const frozenValue = replay.getMirror().getNode(id).value;
          replay.destroy();
          return { values, pausedTime, pausedValue, frozenValue };
        },
        { events, useVirtualDom, id: summary.id },
      );
      expect(result.values).toEqual(['•', '••••', '••••••••', '••']);
      const expectedLength =
        result.pausedTime >= 5200
          ? 8
          : Math.min(8, 1 + Math.floor((result.pausedTime - 100) / 1000));
      expect(result.pausedValue).toBe('•'.repeat(expectedLength));
      expect(result.frozenValue).toBe(result.pausedValue);
    },
  );

  it('keeps snapshots constant and suppresses masked value mutations until blur', async () => {
    await ctx.page.$eval('#test', (element) =>
      element.setAttribute('value', 'secret'),
    );
    await start();
    const snapshot = ctx.events.find(
      (event) => event.type === EventType.FullSnapshot,
    )!;
    expect(JSON.stringify(snapshot)).toContain('********');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    await ctx.page.click('#test');
    ctx.events = [];
    for (const value of ['', 'longer secret', 'short']) {
      await ctx.page.$eval(
        '#test',
        (element, value) => element.setAttribute('value', value),
        value,
      );
      await waitForRAF(ctx.page);
    }
    expect(inputEvents(ctx.events)).toEqual([]);
    expect(
      ctx.events.filter(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Mutation,
      ),
    ).toEqual([]);
    await blur();
    expect(inputEvents(ctx.events)).toMatchObject([
      { text: '********', inputKinds: [] },
    ]);
  });

  it('preserves last-change sampling for unmasked fields', async () => {
    await start({
      maskAllInputs: false,
      maskInputOptions: { text: false },
      sampling: { input: 'last' },
    });
    await ctx.page.type('#test', 'abc');
    await waitForRAF(ctx.page);
    expect(inputEvents(ctx.events)).toEqual([]);
    await blur();
    expect(inputEvents(ctx.events).map((event) => event.text)).toEqual(['abc']);
  });

  it('preserves unmasked input events', async () => {
    await start({ maskAllInputs: false, maskInputOptions: { text: false } });
    await ctx.page.type('#test', 'abc');
    await waitForRAF(ctx.page);
    expect(inputEvents(ctx.events).map((event) => event.text)).toEqual([
      'a',
      'ab',
      'abc',
    ]);
    expect(inputEvents(ctx.events).every((event) => !event.masked)).toBe(true);
  });
});

function inputEvents(events: eventWithTime[]): inputData[] {
  return events
    .filter(
      (event): event is eventWithTime & { data: inputData } =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Input,
    )
    .map((event) => event.data);
}
