import type { InputKind, inputValue } from '@rrweb/types';

/** Autofill has no standard inputType; replacement text also covers autocorrect. */
export function getInputKind(
  event: Event,
  element: HTMLElement,
): InputKind | undefined {
  if (event.type !== 'input') return;
  const inputType = (event as InputEvent).inputType || '';
  if (inputType.startsWith('delete')) return 'delete';
  if (inputType.startsWith('insertFromPaste') || inputType === 'insertFromDrop')
    return 'paste';
  for (const selector of [':autofill', ':-webkit-autofill']) {
    try {
      if (element.matches(selector)) return 'autofill';
    } catch {
      // Unsupported pseudo-class.
    }
  }
  // Browsers and password managers may omit inputType for autofill.
  // This is a best-effort classification, not proof of browser autofill.
  return inputType ? 'insert' : 'autofill';
}

export class InputActivity {
  private states = new WeakMap<
    HTMLElement,
    {
      filled: boolean;
      visiting: boolean;
      kinds: Set<InputKind>;
    }
  >();

  seed(element: HTMLElement, filled: boolean, visiting = false) {
    const state = this.states.get(element);
    if (!state) {
      this.states.set(element, { filled, visiting, kinds: new Set() });
    } else if (visiting && !state.visiting) {
      state.filled = filled;
      state.visiting = true;
      state.kinds.clear();
    }
  }

  update(element: HTMLElement, filled: boolean, kind?: InputKind): void {
    this.seed(element, false);
    const state = this.states.get(element)!;
    if (kind) state.kinds.add(kind);
    state.filled = filled;
  }

  blur(element: HTMLElement): inputValue | undefined {
    const state = this.states.get(element);
    if (!state || !state.visiting) return;
    state.visiting = false;
    const inputKinds = Array.from(state.kinds).sort();
    state.kinds.clear();
    return {
      text: state.filled ? '********' : '',
      isChecked: false,
      masked: true,
      inputKinds,
    };
  }
}
