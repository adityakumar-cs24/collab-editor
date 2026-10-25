import { describe, it, expect } from "vitest";
import { codePointToUtf16Index, diffCodePoints, shiftPosition, utf16ToCodePointIndex } from "./diff";

describe("diffCodePoints", () => {
  it("returns null when nothing changed", () => {
    expect(diffCodePoints("same", "same")).toBeNull();
  });

  it("detects an append", () => {
    expect(diffCodePoints("hello", "hello!")).toEqual({ index: 5, deleteCount: 0, insert: ["!"] });
  });

  it("detects an insert in the middle", () => {
    expect(diffCodePoints("ac", "abc")).toEqual({ index: 1, deleteCount: 0, insert: ["b"] });
  });

  it("detects a deletion", () => {
    expect(diffCodePoints("abc", "ac")).toEqual({ index: 1, deleteCount: 1, insert: [] });
  });

  it("detects a replacement (typing over a selection)", () => {
    expect(diffCodePoints("hello world", "hello there")).toEqual({
      index: 6,
      deleteCount: 5,
      insert: ["t", "h", "e", "r", "e"],
    });
  });

  it("counts an emoji as one character", () => {
    expect(diffCodePoints("a😀b", "ab")).toEqual({ index: 1, deleteCount: 1, insert: [] });
  });

  it("handles repeated characters", () => {
    expect(diffCodePoints("aa", "aaa")).toEqual({ index: 2, deleteCount: 0, insert: ["a"] });
  });
});

describe("shiftPosition", () => {
  const insertion = { index: 5, deleteCount: 0, insert: ["x", "y"] };

  it("leaves positions before the edit alone", () => {
    expect(shiftPosition(3, insertion)).toBe(3);
    expect(shiftPosition(5, insertion)).toBe(5);
  });

  it("moves positions after an insertion", () => {
    expect(shiftPosition(8, insertion)).toBe(10);
  });

  it("moves positions after a replacement", () => {
    const replacement = { index: 2, deleteCount: 3, insert: ["z"] };
    expect(shiftPosition(5, replacement)).toBe(3);
    expect(shiftPosition(10, replacement)).toBe(8);
  });

  it("puts a caret that was inside the removed range after the insertion", () => {
    const replacement = { index: 2, deleteCount: 3, insert: ["z"] };
    expect(shiftPosition(4, replacement)).toBe(3);
  });
});

describe("utf16 conversions", () => {
  it("round trips around an emoji", () => {
    const text = "a😀b"; // a = 1 unit, emoji = 2 units, b = 1 unit
    expect(utf16ToCodePointIndex(text, 3)).toBe(2);
    expect(codePointToUtf16Index(text, 2)).toBe(3);
  });
});
