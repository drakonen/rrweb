# Events

The events recorded by rrweb are a set of strictly-typed JSON data. You may discover some flexible ways to use them when you are familiar with the details.

## Data Types

Every event has a `timestamp` attribute to record the time it was emitted.

There is also a `type` attribute indicates the event's type, the semantic of event's type is:

```
type -> EventType.DomContentLoaded
event -> domContentLoadedEvent

type = EventType.Load
event -> loadedEvent

type -> EventType.FullSnapshot
event -> fullSnapshotEvent

type -> EventType.IncrementalSnapshot
event -> incrementalSnapshotEvent

type -> EventType.Meta
event -> metaEvent

type -> EventType.Custom
event -> customEvent
```

The EventType is Typescript's numeric enum, which is a self-increased number from 0 in runtime. You can find its definition in this [list](https://github.com/rrweb-io/rrweb/blob/9488deb6d54a5f04350c063d942da5e96ab74075/src/types.ts#L10).

In these kinds of events, the incrementalSnapshotEvent is the event that contains incremental data. You can use `event.data.source` to find which kind of incremental data it belongs to:

```
source -> IncrementalSource.Mutation
data -> mutationData

source -> IncrementalSource.MouseMove
data -> mousemoveData

source -> IncrementalSource.MouseInteraction
data -> mouseInteractionData

source -> IncrementalSource.Scroll
data -> scrollData

source -> IncrementalSource.ViewportResize
data -> viewportResizeData

source -> IncrementalSource.Input
data -> inputData

source -> IncrementalSource.TouchMove
data -> mouseInteractionData

source -> IncrementalSource.MediaInteraction
data -> mediaInteractionData

source -> IncrementalSource.StyleSheetRule
data -> styleSheetRuleData

source -> IncrementalSource.CanvasMutation
data -> canvasMutationData

source -> IncrementalSource.Font
data -> fontData
```

enum IncrementalSource's definition can be found in this [list](https://github.com/rrweb-io/rrweb/blob/98e71cd0d23628cd1fbdbe47664a65748084c4a4/packages/types/src/index.ts#L69).

## Masked input interactions

Masked input values use eight `*` characters, capped by the field's nonnegative
`maxLength`. Empty values remain empty. This applies to snapshots, value mutations,
and input events. A custom `maskInputFn` takes precedence over this default.

For masked text inputs and textareas, the first trusted user input while focused
emits an input event with `maskFocus: true`. Intermediate input and change events
are suppressed until blur, which emits the final masked value with `maskBlur:
true`. These flags describe editing, so focusing without typing emits neither.
Programmatic changes do not start editing sessions. With `sampling.input: 'last'`,
only the change event is recorded, with `maskBlur: true`.
If removal skips blur, later value updates remain recordable and checkout
snapshots do not mark an unfocused field as editing.

Both attributes are optional; recordings without them replay as before. Replay
sets `data-rrweb-masked-editing="true"` on the field between start and end events,
and emits `ReplayerEvents.MaskedInput` (`'masked-input'`) with the input data and
the replay DOM `target`. Checkout snapshots preserve the attribute for ongoing
edits. A viewer can use that event or style the attribute:

```js
const replayer = new Replayer(events, {
  insertStyleRules: [
    '[data-rrweb-masked-editing="true"] { outline: 2px solid #2563eb; }',
  ],
});

replayer.on('masked-input', ({ id, maskFocus, maskBlur, target }) => {
  // Update viewer UI for this field. Callbacks also run when seeking.
});
```

## Recording

For a recording to be replayable, it usually should begins with a `Meta` event which contains the URL of the page and screen dimensions, followed by a `FullSnapshot` event which is used to rebuild the HTML state. Both user actions and page state changes come in through subsequent `IncrementalSnapshot` events, with `source: IncrementalSource.Mutation` for the state changes. These type of events are known as 'mutation events', and one builds upon the next, meaning they should be replayed in the correct order; if one of them is dropped subsequent mutations may fail (for example one mutation adds a nav element, and the next mutation has an attribute change representing the hover state for a nav item in the menu). See the [Sequential ID plugin](packages/plugins/rrweb-plugin-sequential-id-record/) for how to add debug event ordering problems.

When a user navigates to another page on a website, this process begins again with another pair of Meta + FullSnapshot events. Each subsequent mutation event builds incrementally on the first FullSnapshot of a page load. Event streams can be linearly combined into a single 'Session Replay' so long as mutations are associated with the correct full snapshot. Note that rrweb Cloud has extra facilities for recreating multi-tab browsing sessions correctly; see the cloud [Replaying Guide](https://rrweb.com/docs/cloud/replaying-guide) for an overview or the [Get replay](https://rrweb.com/docs/operations/get-replays-%7BgroupingProp%7D-%7BreplayValue%7D) endpoint for how to compose or combine multiple recordings.
