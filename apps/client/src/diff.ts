// A change to the text, in code points (not UTF-16 units), because the CRDT stores one code point per node.
export interface TextEdit {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: readonly string[];
}

// Smallest single edit that turns oldText into newText: strip the common prefix and suffix.
export function diffCodePoints(oldText: string, newText: string): TextEdit | null {
  const a = Array.from(oldText);
  const b = Array.from(newText);

  let start = 0;
  const shortest = Math.min(a.length, b.length);
  while (start < shortest && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start === endA && start === endB) return null; // identical
  return { index: start, deleteCount: endA - start, insert: b.slice(start, endB) };
}

// Where does a caret at `pos` (in code points) end up after the edit?
export function shiftPosition(pos: number, edit: TextEdit): number {
  if (pos <= edit.index) return pos;
  const removedEnd = edit.index + edit.deleteCount;
  if (pos >= removedEnd) return pos - edit.deleteCount + edit.insert.length;
  return edit.index + edit.insert.length; // the caret was inside the removed range
}

// DOM selections are in UTF-16 units; the CRDT works in code points.
export function utf16ToCodePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

export function codePointToUtf16Index(text: string, codePointIndex: number): number {
  return Array.from(text).slice(0, codePointIndex).join("").length;
}
