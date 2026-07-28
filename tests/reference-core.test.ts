import assert from "node:assert/strict";
import test from "node:test";
import {
  findSemanticTargetChanges,
  findFormulaReferenceByInlineOrdinal,
  findInlineSemanticTrigger,
  findWikiLinkAtOffset,
  findFormulaReferenceRanges,
  findInlineFormulaRanges,
  makeFragmentForTarget,
  normalizeFormulaTag,
  parseFormulaReferenceSource,
  parseFormulaReferenceText,
  parseFragmentRequest,
  parseSemanticNote,
  rewriteSemanticWikiLinks,
  stripFormulaTag,
} from "../src/reference-core";

test("parses custom quote headings and stops at the next semantic boundary", () => {
  const note = [
    "# 第一章",
    "",
    "> **B.O.近似** ^subheading-a1b2c3",
    "",
    "第一段。",
    "",
    "> **下一标题**",
    "",
    "第二段。",
  ].join("\n");

  const parsed = parseSemanticNote(note);
  assert.equal(parsed.subheadings.length, 2);
  assert.equal(parsed.subheadings[0].label, "B.O.近似");
  assert.equal(parsed.subheadings[0].lineStart, 2);
  assert.equal(parsed.subheadings[0].lineEnd, 5);
  assert.doesNotMatch(
    parsed.subheadings[0].markdown,
    /\^subheading-/,
  );
});

test("ignores title and formula syntax inside fenced code", () => {
  const note = [
    "```md",
    "> **不是标题**",
    "$$x=1 \\\\tag{1-1}$$",
    "```",
    "> **真实标题**",
  ].join("\n");
  const parsed = parseSemanticNote(note);
  assert.deepEqual(
    parsed.subheadings.map((target) => target.label),
    ["真实标题"],
  );
  assert.equal(parsed.formulas.length, 0);
});

test("parses tagged display formulas including blockquotes", () => {
  const note = [
    "> $$E=mc^2 \\\\tag{1-7}$$",
    "",
    "> $$",
    "> a=b \\\\tag{2 - 3}",
    "> $$",
  ].join("\n");
  const parsed = parseSemanticNote(note);
  assert.deepEqual(
    parsed.formulas.map((target) => target.label),
    ["1-7", "2-3"],
  );
  assert.doesNotMatch(parsed.formulas[1].markdown, /^\s*>/m);
});

test("assigns stable occurrence suffixes for duplicate semantic titles", () => {
  const note = [
    "> **定义**",
    "",
    "A",
    "",
    "> **定义**",
    "",
    "B",
  ].join("\n");
  const parsed = parseSemanticNote(note);
  assert.equal(parsed.subheadings[1].occurrence, 2);
  assert.equal(
    makeFragmentForTarget(parsed.subheadings[1]),
    "-定义 1",
  );
  assert.deepEqual(parseFragmentRequest("#-定义 1"), {
    kind: "subheading",
    lookupKey: "定义",
    occurrence: 2,
    label: "定义 1",
    fallback: {
      lookupKey: "定义 1",
      occurrence: 1,
    },
  });
  assert.deepEqual(parseFragmentRequest("#-定义§2"), {
    kind: "subheading",
    lookupKey: "定义",
    occurrence: 2,
    label: "定义",
  });
});

test("recognizes current-file and cross-file semantic completion triggers", () => {
  assert.deepEqual(findInlineSemanticTrigger("[[#=", "="), {
    embed: false,
    linkPath: "",
  });
  assert.deepEqual(
    findInlineSemanticTrigger("[[抽象代数 01群论基础#=", "="),
    {
      embed: false,
      linkPath: "抽象代数 01群论基础",
    },
  );
  assert.deepEqual(
    findInlineSemanticTrigger("前文 ![[物理化学 04分子点群#-", "-"),
    {
      embed: true,
      linkPath: "物理化学 04分子点群",
    },
  );
  assert.equal(findInlineSemanticTrigger("文件名#=", "="), null);
  assert.equal(findInlineSemanticTrigger("[[文件名#=已输入", "="), null);
});

test("recognizes formula fragments and rendered reference text", () => {
  assert.deepEqual(parseFragmentRequest("#=(1−7)"), {
    kind: "formula",
    lookupKey: "1-7",
    occurrence: 1,
    label: "(1-7)",
  });
  assert.equal(parseFragmentRequest("#定义"), null);
  assert.equal(parseFragmentRequest("#(1-7)"), null);
  assert.equal(parseFormulaReferenceText("( 1−7 )"), "1-7");
  assert.equal(
    parseFormulaReferenceSource("\\text{ ( 01−007 ) }"),
    "1-7",
  );
  assert.equal(normalizeFormulaTag(" 02 – 003 "), "02-003");
});

test("finds the existing Templater formula reference syntax", () => {
  const source =
    "由$\\text{(1-7)}$式可知，另见 $ \\text{ ( 2 − 3 ) } $。";
  assert.deepEqual(
    findFormulaReferenceRanges(source).map((range) => range.tag),
    ["1-7", "2-3"],
  );
});

test("strips the source tag when a formula is embedded cross-file", () => {
  assert.equal(
    stripFormulaTag("$$\na=b \\tag{9-9}\n$$"),
    "$$\na=b \n$$",
  );
});

test("maps rendered inline-math order back to a source line range", () => {
  const source = [
    "正文 $x+y$ 与 $\\text{(3-1)}$。",
    "$$z=1 \\\\tag{3-1}$$",
    "下一段 $\\text{(3-2)}$。",
    "```md",
    "$\\text{(9-9)}$",
    "```",
  ].join("\n");
  assert.deepEqual(
    findInlineFormulaRanges(source).map((range) => range.tag),
    [null, "3-1", "3-2"],
  );
  assert.equal(
    findFormulaReferenceByInlineOrdinal(source, 0, 0, 0),
    null,
  );
  assert.equal(
    findFormulaReferenceByInlineOrdinal(source, 0, 0, 1),
    "3-1",
  );
  assert.equal(
    findFormulaReferenceByInlineOrdinal(source, 2, 2, 0),
    "3-2",
  );
});

test("finds a semantic wiki link at a Live Preview source offset", () => {
  const source =
    "前文 [[#-验收自制标题|显示标题]] 后文\n" +
    "跨文件 [[抽象代数 01群论基础#=(1-3)]]";
  assert.equal(
    findWikiLinkAtOffset(source, source.indexOf("显示标题")),
    "#-验收自制标题",
  );
  assert.equal(
    findWikiLinkAtOffset(source, source.indexOf("(1-3)")),
    "抽象代数 01群论基础#=(1-3)",
  );
});

test("tracks simultaneous formula renumbering without cascading", () => {
  const previous = parseSemanticNote(
    [
      "$$x=1 \\\\tag{1-1}$$",
      "$$y=2 \\\\tag{1-2}$$",
    ].join("\n"),
  );
  const current = parseSemanticNote(
    [
      "$$x=1 \\\\tag{1-2}$$",
      "$$y=2 \\\\tag{1-3}$$",
    ].join("\n"),
  );

  assert.deepEqual(
    findSemanticTargetChanges(
      previous.formulas,
      current.formulas,
      "formula",
    ).map((change) => [
      makeFragmentForTarget(change.previous),
      makeFragmentForTarget(change.current),
    ]),
    [
      ["=(1-1)", "=(1-2)"],
      ["=(1-2)", "=(1-3)"],
    ],
  );
});

test("tracks a renamed duplicate heading and shifted occurrence", () => {
  const previous = parseSemanticNote(
    [
      "> **定义**",
      "第一段",
      "> **定义**",
      "第二段",
    ].join("\n"),
  );
  const current = parseSemanticNote(
    [
      "> **基本定义**",
      "第一段",
      "> **定义**",
      "第二段",
    ].join("\n"),
  );

  assert.deepEqual(
    findSemanticTargetChanges(
      previous.subheadings,
      current.subheadings,
      "subheading",
    ).map((change) => [
      makeFragmentForTarget(change.previous),
      makeFragmentForTarget(change.current),
    ]),
    [
      ["-定义", "-基本定义"],
      ["-定义 1", "-定义"],
    ],
  );
});

test("does not guess when repeated target bodies become ambiguous", () => {
  const previous = parseSemanticNote(
    ["> **旧标题一**", "> **旧标题二**"].join("\n"),
  );
  const current = parseSemanticNote("> **新标题**");

  assert.deepEqual(
    findSemanticTargetChanges(
      previous.subheadings,
      current.subheadings,
      "subheading",
    ),
    [],
  );
});

test("rewrites semantic wiki links while preserving code and custom aliases", () => {
  const source = [
    "[[目标#=(1-1)|(1-1)]] 与 ![[目标#=(1-2)]]",
    "[[目标#=(1-1)|自定义说明]]",
    "`[[目标#=(1-1)]]`",
    "```md",
    "[[目标#=(1-1)]]",
    "```",
    "[[别的文件#=(1-1)]]",
  ].join("\n");
  const replacements = new Map([
    ["1-1", { tag: "1-2", oldAlias: "(1-1)", newAlias: "(1-2)" }],
    ["1-2", { tag: "1-3", oldAlias: "(1-2)", newAlias: "(1-3)" }],
  ]);

  const rewritten = rewriteSemanticWikiLinks(source, (link) => {
    if (link.linkPath !== "目标") {
      return null;
    }
    const request = parseFragmentRequest(link.fragment);
    if (!request || request.kind !== "formula") {
      return null;
    }
    const replacement = replacements.get(request.lookupKey);
    if (!replacement) {
      return null;
    }
    return {
      fragment: `=(${replacement.tag})`,
      alias:
        link.alias === replacement.oldAlias
          ? replacement.newAlias
          : undefined,
    };
  });

  assert.equal(rewritten.replacements, 3);
  assert.equal(
    rewritten.markdown,
    [
      "[[目标#=(1-2)|(1-2)]] 与 ![[目标#=(1-3)]]",
      "[[目标#=(1-2)|自定义说明]]",
      "`[[目标#=(1-1)]]`",
      "```md",
      "[[目标#=(1-1)]]",
      "```",
      "[[别的文件#=(1-1)]]",
    ].join("\n"),
  );
});

test("rewrites legacy duplicate heading fragments and leaves escaped links alone", () => {
  const source =
    "[[#-定义§2|定义 1]]、\\![[#-定义§2]]、[[#-定义§2|说明]]";
  const rewritten = rewriteSemanticWikiLinks(source, (link) => {
    const request = parseFragmentRequest(link.fragment);
    if (
      !request ||
      request.kind !== "subheading" ||
      request.lookupKey !== "定义" ||
      request.occurrence !== 2
    ) {
      return null;
    }
    return {
      fragment: "-定义",
      alias: link.alias === "定义 1" ? "定义" : undefined,
    };
  });

  assert.equal(rewritten.replacements, 2);
  assert.equal(
    rewritten.markdown,
    "[[#-定义|定义]]、\\![[#-定义§2]]、[[#-定义|说明]]",
  );
});
