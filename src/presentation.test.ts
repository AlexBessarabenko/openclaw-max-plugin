import { describe, expect, it } from "vitest";
import { decodeMaxPresentationCallback, monospaceTable } from "./presentation.js";

describe("decodeMaxPresentationCallback", () => {
  it("decodes opaque callback envelopes", () => {
    expect(decodeMaxPresentationCallback("mxcb1:vote:yes")).toEqual({
      kind: "callback",
      value: "vote:yes",
    });
  });

  it("decodes approval envelopes", () => {
    expect(decodeMaxPresentationCallback("mxa1:e:o:ap-1")).toEqual({
      kind: "approval",
      approvalKind: "exec",
      decision: "allow-once",
      approvalId: "ap-1",
    });
    expect(decodeMaxPresentationCallback("mxa1:s:d:ap-2")).toEqual({
      kind: "approval",
      approvalKind: "system-agent",
      decision: "deny",
      approvalId: "ap-2",
    });
  });

  it("decodes question envelopes (option values may contain colons)", () => {
    expect(decodeMaxPresentationCallback("mxq1:q-1:opt:2")).toEqual({
      kind: "question",
      questionId: "q-1",
      optionValue: "opt:2",
    });
  });

  it("returns null for plain payloads and malformed envelopes", () => {
    expect(decodeMaxPresentationCallback("vote:yes")).toBeNull();
    expect(decodeMaxPresentationCallback("/status")).toBeNull();
    expect(decodeMaxPresentationCallback("")).toBeNull();
    expect(decodeMaxPresentationCallback(null)).toBeNull();
    expect(decodeMaxPresentationCallback("mxcb1:")).toBeNull();
    expect(decodeMaxPresentationCallback("mxa1:x:o:ap")).toBeNull();
    expect(decodeMaxPresentationCallback("mxq1::v")).toBeNull();
    expect(decodeMaxPresentationCallback("mxq1:q:")).toBeNull();
  });
});

describe("monospaceTable", () => {
  it("aligns columns by display width", () => {
    expect(
      monospaceTable(["a", "bb"], [["ccc", "d"], ["e", "ff"]]),
    ).toBe("```\na   | bb\n----+---\nccc | d\ne   | ff\n```");
  });
});
