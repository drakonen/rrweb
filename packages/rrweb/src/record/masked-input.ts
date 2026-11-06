import { NodeType } from '@rrweb/types';
import type { Mirror } from 'rrweb-snapshot';

export const maskedInputEdits = new WeakMap<Document, WeakSet<EventTarget>>();

export function isFocused(node: Node): boolean {
  return (
    node.isConnected &&
    (node.getRootNode() as Document | ShadowRoot).activeElement === node
  );
}

export function isMaskedInputEditing(node: Node): boolean {
  return Boolean(
    node.ownerDocument &&
      maskedInputEdits.get(node.ownerDocument)?.has(node) &&
      isFocused(node),
  );
}

/** Preserve ongoing editing when replay starts from a checkout snapshot. */
export function serializeMaskedInputState(node: Node, mirror: Mirror) {
  if (!isMaskedInputEditing(node)) return;
  const serialized = mirror.getMeta(node);
  if (serialized?.type === NodeType.Element) {
    serialized.attributes['data-rrweb-masked-editing'] = 'true';
  }
}
