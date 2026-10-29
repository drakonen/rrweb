import { EventType, IncrementalSource, MouseInteractions } from '@rrweb/types';
import type { eventWithTime, inputData } from '@rrweb/types';

type Field = { value: string; since: number | null; immediate: boolean };

/** Synthetic dots depend only on focus time, never on recorded keystrokes. */
export class InputActivityReplay {
  private fields = new Map<number, Field>();
  private visits = new Map<
    eventWithTime,
    { summary: inputData; end: number }
  >();
  private eventCount = -1;

  reset() {
    this.fields.clear();
  }

  /** Saved recordings can look ahead to the blur summary without storing edit times. */
  summaryFor(
    focus: eventWithTime,
    events: eventWithTime[],
  ): inputData | undefined {
    if (events.length !== this.eventCount) {
      this.eventCount = events.length;
      this.visits.clear();
      const focused = new Map<number, eventWithTime>();
      for (const event of events) {
        if (event.type === EventType.Meta) focused.clear();
        if (event.type !== EventType.IncrementalSnapshot) continue;
        const data = event.data;
        if (
          data.source === IncrementalSource.MouseInteraction &&
          data.type === MouseInteractions.Focus
        ) {
          focused.set(data.id, event);
        } else if (
          data.source === IncrementalSource.Input &&
          data.masked &&
          data.inputKinds
        ) {
          const start = focused.get(data.id);
          if (start)
            this.visits.set(start, { summary: data, end: event.timestamp });
          focused.delete(data.id);
        }
      }
    }
    return this.visits.get(focus)?.summary;
  }

  restore(timestamp: number, events: eventWithTime[]) {
    this.reset();
    if (!events.length) return;
    this.summaryFor(events[0], events);
    for (const [focus, { summary, end }] of this.visits) {
      if (focus.timestamp <= timestamp && timestamp < end) {
        this.focus(summary.id, focus.timestamp, summary);
      }
    }
  }

  focus(id: number, timestamp: number, summary?: inputData) {
    if (!summary || !summary.inputKinds?.length) return;
    this.fields.set(id, {
      value: summary.text,
      since: timestamp,
      immediate:
        summary.inputKinds.includes('paste') ||
        summary.inputKinds.includes('autofill'),
    });
  }

  blur(id: number) {
    // The summary will replace the synthetic value with the final field state.
    const field = this.fields.get(id);
    if (field) field.since = null;
  }

  input(data: inputData) {
    if (!data.masked) {
      this.fields.delete(data.id);
      return;
    }
    this.fields.set(data.id, {
      value: data.text,
      since: null,
      immediate: true,
    });
  }

  value(id: number, timestamp: number): string | undefined {
    const field = this.fields.get(id);
    if (!field) return;
    if (field.since === null) return field.value ? '•'.repeat(8) : '';
    if (field.immediate) return '•'.repeat(8);
    return '•'.repeat(
      Math.min(8, 1 + Math.floor(Math.max(0, timestamp - field.since) / 1000)),
    );
  }

  needsAnimation(timestamp: number): boolean {
    return Array.from(this.fields.values()).some(
      (field) =>
        !field.immediate &&
        field.since !== null &&
        timestamp - field.since < 7000,
    );
  }

  render(timestamp: number, setValue: (id: number, value: string) => void) {
    for (const id of this.fields.keys())
      setValue(id, this.value(id, timestamp)!);
  }
}
