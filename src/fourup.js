// Backwards-compatible shim. The original fixed 2x2 "4-up" composer has
// been generalised into an adaptive contact-sheet composer that picks
// between single / stacked / 1+2 / 2x2 layouts based on the page count.
// New code should import from './contactSheet.js' directly.

export { composeContactSheetA4, composeFourUpA4, chunkInto } from './contactSheet.js';
