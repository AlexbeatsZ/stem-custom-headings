export type SemanticTargetKind = "subheading" | "formula";

export interface ParsedSemanticTarget {
  kind: SemanticTargetKind;
  label: string;
  lookupKey: string;
  lineStart: number;
  lineEnd: number;
  markdown: string;
  occurrence: number;
}

export interface ParsedSemanticNote {
  subheadings: ParsedSemanticTarget[];
  formulas: ParsedSemanticTarget[];
}

export interface FragmentRequest {
  kind: SemanticTargetKind;
  lookupKey: string;
  occurrence: number;
  label: string;
  fallback?: {
    lookupKey: string;
    occurrence: number;
  };
}

export interface InlineSemanticTrigger {
  embed: boolean;
  linkPath: string;
}

export interface SemanticTargetChange {
  previous: ParsedSemanticTarget;
  current: ParsedSemanticTarget;
}

export interface ParsedWikiSemanticLink {
  embed: boolean;
  linkPath: string;
  fragment: string;
  alias: string | null;
}

export interface WikiSemanticLinkReplacement {
  fragment: string;
  alias?: string | null;
}

export interface WikiSemanticLinkRewriteResult {
  markdown: string;
  replacements: number;
}

const CUSTOM_TITLE_RE =
  /^\s*>\s*\*\*(.+)\*\*(?:\s+\^subheading-[a-f0-9]{6})?\s*$/i;
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const FORMULA_TAG_RE = /\\tag\s*\{\s*([^{}]+?)\s*\}/i;
const TRAILING_SUBHEADING_ID_RE =
  /\s+\^subheading-[a-f0-9]{6}\s*$/i;

const DASH_RE = /[\u2010\u2011\u2012\u2013\u2014\u2212]/g;

export function normalizeLookupText(value: string): string {
  return safeDecodeURIComponent(value)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function normalizeFormulaTag(value: string): string {
  return safeDecodeURIComponent(value)
    .normalize("NFC")
    .replace(DASH_RE, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

export function parseFormulaReferenceText(text: string): string | null {
  const normalized = text
    .normalize("NFC")
    .replace(DASH_RE, "-")
    .trim();
  const match = normalized.match(/^\(\s*(\d+)\s*-\s*(\d+)\s*\)$/);
  return match ? `${Number(match[1])}-${Number(match[2])}` : null;
}

export function parseFormulaReferenceSource(source: string): string | null {
  const normalized = source
    .normalize("NFC")
    .replace(DASH_RE, "-")
    .trim();
  const match = normalized.match(
    /^\$?\s*\\text\s*\{\s*\(\s*(\d+)\s*-\s*(\d+)\s*\)\s*\}\s*\$?$/,
  );
  return match ? `${Number(match[1])}-${Number(match[2])}` : null;
}

export function stripFormulaTag(source: string): string {
  return source.replace(/\\tag\s*\{[^{}]*\}/gi, "").trim();
}

export function findWikiLinkAtOffset(
  source: string,
  offset: number,
): string | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return null;
  }
  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextNewline = source.indexOf("\n", offset);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  const line = source.slice(lineStart, lineEnd);
  const relativeOffset = offset - lineStart;
  const linkStart = line.lastIndexOf("[[", relativeOffset);
  if (linkStart === -1) {
    return null;
  }
  const linkEnd = line.indexOf("]]", Math.max(relativeOffset, linkStart + 2));
  if (linkEnd === -1 || relativeOffset > linkEnd + 2) {
    return null;
  }
  const inner = line.slice(linkStart + 2, linkEnd);
  const aliasIndex = firstUnescapedPipe(inner);
  const linktext = (
    aliasIndex === -1 ? inner : inner.slice(0, aliasIndex)
  ).trim();
  return linktext || null;
}

export function findInlineSemanticTrigger(
  beforeCursor: string,
  namespace: "-" | "=",
): InlineSemanticTrigger | null {
  const marker = `#${namespace}`;
  if (!beforeCursor.endsWith(marker)) {
    return null;
  }
  const openerStart = beforeCursor.lastIndexOf("[[");
  if (openerStart === -1) {
    return null;
  }
  const linkBody = beforeCursor.slice(
    openerStart + 2,
    beforeCursor.length - marker.length,
  );
  if (
    linkBody.includes("]]") ||
    linkBody.includes("|") ||
    linkBody.includes("\n")
  ) {
    return null;
  }
  return {
    embed:
      openerStart > 0 && beforeCursor[openerStart - 1] === "!",
    linkPath: linkBody.trim(),
  };
}

export function parseFragmentRequest(fragment: string): FragmentRequest | null {
  let decoded = safeDecodeURIComponent(fragment).trim();
  if (decoded.startsWith("#")) {
    decoded = decoded.slice(1).trim();
  }
  if (!decoded || decoded.startsWith("^")) {
    return null;
  }

  const namespace = decoded[0];
  if (namespace !== "-" && namespace !== "=") {
    return null;
  }
  decoded = decoded.slice(1).trim();
  if (!decoded) {
    return null;
  }

  let occurrence = 1;
  let usedLegacyOccurrence = false;
  const occurrenceMatch = decoded.match(/^(.*)§(\d+)$/);
  if (occurrenceMatch) {
    decoded = occurrenceMatch[1].trim();
    occurrence = Math.max(1, Number(occurrenceMatch[2]));
    usedLegacyOccurrence = true;
  }

  if (namespace === "=") {
    const formulaMatch = decoded.match(/^\((.+)\)$/);
    if (!formulaMatch) {
      return null;
    }
    const formulaTag = normalizeFormulaTag(formulaMatch[1]);
    if (/^\d+-\d+$/.test(formulaTag)) {
      return {
        kind: "formula",
        lookupKey: formulaTag,
        occurrence,
        label: `(${formulaTag})`,
      };
    }
    return null;
  }

  if (!usedLegacyOccurrence) {
    const duplicateMatch = decoded.match(/^(.*\S)\s+(\d+)$/);
    if (duplicateMatch) {
      const duplicateIndex = Number(duplicateMatch[2]);
      if (Number.isSafeInteger(duplicateIndex) && duplicateIndex >= 1) {
        return {
          kind: "subheading",
          lookupKey: normalizeLookupText(duplicateMatch[1]),
          occurrence: duplicateIndex + 1,
          label: decoded,
          fallback: {
            lookupKey: normalizeLookupText(decoded),
            occurrence: 1,
          },
        };
      }
    }
  }

  return {
    kind: "subheading",
    lookupKey: normalizeLookupText(decoded),
    occurrence,
    label: decoded,
  };
}

function firstUnescapedPipe(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "|") {
      continue;
    }
    let backslashCount = 0;
    for (
      let previous = index - 1;
      previous >= 0 && value[previous] === "\\";
      previous -= 1
    ) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 0) {
      return index;
    }
  }
  return -1;
}

export function makeFragmentForTarget(target: ParsedSemanticTarget): string {
  if (target.kind === "subheading") {
    const suffix =
      target.occurrence > 1 ? ` ${target.occurrence - 1}` : "";
    return `-${target.label}${suffix}`;
  }
  const base = `=(${target.label})`;
  return target.occurrence > 1 ? `${base}§${target.occurrence}` : base;
}

export function encodeSemanticFragment(value: string): string {
  return value.replace(/[%#|\[\]]/g, (character) =>
    encodeURIComponent(character),
  );
}

export function findSemanticTargetChanges(
  previousTargets: ParsedSemanticTarget[],
  currentTargets: ParsedSemanticTarget[],
  kind: SemanticTargetKind,
): SemanticTargetChange[] {
  const previous = previousTargets.filter(
    (target) => target.kind === kind,
  );
  const current = currentTargets.filter(
    (target) => target.kind === kind,
  );
  const previousMatched = new Set<number>();
  const currentMatched = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const previousByFingerprint = groupTargetIndexesByFingerprint(
    previous,
    kind,
  );
  const currentByFingerprint = groupTargetIndexesByFingerprint(
    current,
    kind,
  );

  for (const [fingerprint, previousIndexes] of previousByFingerprint) {
    const currentIndexes = currentByFingerprint.get(fingerprint);
    if (
      !currentIndexes ||
      previousIndexes.length !== currentIndexes.length
    ) {
      continue;
    }
    pairNearestTargets(
      previous,
      current,
      previousIndexes,
      currentIndexes,
      previousMatched,
      currentMatched,
      pairs,
    );
  }

  for (
    let previousIndex = 0;
    previousIndex < previous.length;
    previousIndex += 1
  ) {
    if (previousMatched.has(previousIndex)) {
      continue;
    }
    const candidates: number[] = [];
    for (
      let currentIndex = 0;
      currentIndex < current.length;
      currentIndex += 1
    ) {
      if (
        !currentMatched.has(currentIndex) &&
        current[currentIndex].lineStart ===
          previous[previousIndex].lineStart &&
        (previousByFingerprint.get(
          targetFingerprint(previous[previousIndex], kind),
        )?.length ?? 0) === 1 &&
        (currentByFingerprint.get(
          targetFingerprint(current[currentIndex], kind),
        )?.length ?? 0) === 1
      ) {
        candidates.push(currentIndex);
      }
    }
    if (candidates.length !== 1) {
      continue;
    }
    const currentIndex = candidates[0];
    previousMatched.add(previousIndex);
    currentMatched.add(currentIndex);
    pairs.push([previousIndex, currentIndex]);
  }

  return pairs
    .sort(
      ([leftPrevious], [rightPrevious]) =>
        previous[leftPrevious].lineStart -
        previous[rightPrevious].lineStart,
    )
    .map(([previousIndex, currentIndex]) => ({
      previous: previous[previousIndex],
      current: current[currentIndex],
    }))
    .filter(
      (change) =>
        makeFragmentForTarget(change.previous) !==
        makeFragmentForTarget(change.current),
    );
}

export function rewriteSemanticWikiLinks(
  markdown: string,
  rewrite: (
    link: ParsedWikiSemanticLink,
  ) => WikiSemanticLinkReplacement | null,
): WikiSemanticLinkRewriteResult {
  const lines = markdown.split(/\r?\n/);
  const fencedLines = collectFencedLines(lines);
  let offset = 0;
  let lineIndex = 0;
  let replacements = 0;
  let output = "";

  while (offset < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", offset);
    const segmentEnd =
      newlineIndex === -1 ? markdown.length : newlineIndex;
    let line = markdown.slice(offset, segmentEnd);
    let newline = newlineIndex === -1 ? "" : "\n";
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
      newline = `\r${newline}`;
    }

    if (fencedLines.has(lineIndex)) {
      output += line;
    } else {
      const rewritten = rewriteSemanticWikiLinksInLine(line, rewrite);
      output += rewritten.markdown;
      replacements += rewritten.replacements;
    }
    output += newline;

    if (newlineIndex === -1) {
      offset = markdown.length;
    } else {
      offset = newlineIndex + 1;
      lineIndex += 1;
    }
  }

  return {
    markdown: output,
    replacements,
  };
}

export function parseSemanticNote(markdown: string): ParsedSemanticNote {
  const lines = markdown.split(/\r?\n/);
  const fencedLines = collectFencedLines(lines);
  const subheadings: ParsedSemanticTarget[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (fencedLines.has(lineIndex)) {
      continue;
    }
    const title = parseCustomTitleLine(lines[lineIndex]);
    if (!title) {
      continue;
    }

    let lineEnd = lines.length - 1;
    for (let cursor = lineIndex + 1; cursor < lines.length; cursor += 1) {
      if (fencedLines.has(cursor)) {
        continue;
      }
      if (
        parseCustomTitleLine(lines[cursor]) !== null ||
        MARKDOWN_HEADING_RE.test(lines[cursor])
      ) {
        lineEnd = cursor - 1;
        break;
      }
    }

    const sectionLines = lines.slice(lineIndex, lineEnd + 1);
    sectionLines[0] = sectionLines[0].replace(
      TRAILING_SUBHEADING_ID_RE,
      "",
    );
    subheadings.push({
      kind: "subheading",
      label: title,
      lookupKey: normalizeLookupText(title),
      lineStart: lineIndex,
      lineEnd,
      markdown: trimBlankEdges(sectionLines).join("\n"),
      occurrence: 1,
    });
  }

  assignOccurrences(subheadings);

  const formulas = parseFormulaTargets(markdown, lines, fencedLines);
  assignOccurrences(formulas);

  return { subheadings, formulas };
}

export function findFormulaReferenceRanges(
  markdown: string,
): Array<{ from: number; to: number; tag: string }> {
  const ranges: Array<{ from: number; to: number; tag: string }> = [];
  const re =
    /\$\s*\\text\s*\{\s*\(\s*(\d+)\s*[-\u2010-\u2014\u2212]\s*(\d+)\s*\)\s*\}\s*\$/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    ranges.push({
      from: match.index,
      to: match.index + match[0].length,
      tag: `${Number(match[1])}-${Number(match[2])}`,
    });
  }
  return ranges;
}

export function findInlineFormulaRanges(
  markdown: string,
): Array<{ from: number; to: number; tag: string | null }> {
  const lines = markdown.split(/\r?\n/);
  const fencedLines = collectFencedLines(lines);
  const lineOffsets = computeLineOffsets(markdown);
  const ranges: Array<{
    from: number;
    to: number;
    tag: string | null;
  }> = [];
  const re = /\$(?!\$)(?:\\[\s\S]|[^$\\\r\n])+\$(?!\$)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(markdown)) !== null) {
    if (
      (match.index > 0 &&
        (markdown[match.index - 1] === "$" ||
          markdown[match.index - 1] === "\\")) ||
      fencedLines.has(lineForOffset(lineOffsets, match.index))
    ) {
      continue;
    }
    ranges.push({
      from: match.index,
      to: match.index + match[0].length,
      tag: parseFormulaReferenceSource(match[0]),
    });
  }

  return ranges;
}

export function findFormulaReferenceByInlineOrdinal(
  markdown: string,
  lineStart: number,
  lineEnd: number,
  ordinal: number,
): string | null {
  if (ordinal < 0) {
    return null;
  }
  const lineOffsets = computeLineOffsets(markdown);
  const safeLineStart = Math.max(
    0,
    Math.min(lineOffsets.length - 1, lineStart),
  );
  const safeLineEnd = Math.max(
    safeLineStart,
    Math.min(lineOffsets.length - 1, lineEnd),
  );
  const from = lineOffsets[safeLineStart];
  const to =
    safeLineEnd + 1 < lineOffsets.length
      ? lineOffsets[safeLineEnd + 1]
      : markdown.length;
  const formulas = findInlineFormulaRanges(markdown).filter(
    (range) => range.from >= from && range.to <= to,
  );
  return formulas[ordinal]?.tag ?? null;
}

function parseFormulaTargets(
  markdown: string,
  lines: string[],
  fencedLines: Set<number>,
): ParsedSemanticTarget[] {
  const lineOffsets = computeLineOffsets(markdown);
  const targets: ParsedSemanticTarget[] = [];
  const displayMathRe = /\$\$([\s\S]*?)\$\$/g;
  let match: RegExpExecArray | null;

  while ((match = displayMathRe.exec(markdown)) !== null) {
    const lineStart = lineForOffset(lineOffsets, match.index);
    const lineEnd = lineForOffset(
      lineOffsets,
      match.index + match[0].length - 1,
    );
    if (fencedLines.has(lineStart) || fencedLines.has(lineEnd)) {
      continue;
    }

    const tagMatch = match[1].match(FORMULA_TAG_RE);
    if (!tagMatch) {
      continue;
    }
    const tag = normalizeFormulaTag(tagMatch[1]);
    if (!/^\d+-\d+$/.test(tag)) {
      continue;
    }

    const cleanInner = stripQuotePrefixesFromFormula(match[1]);
    targets.push({
      kind: "formula",
      label: tag,
      lookupKey: tag,
      lineStart,
      lineEnd,
      markdown: `$$${cleanInner}$$`,
      occurrence: 1,
    });
  }

  return targets;
}

function parseCustomTitleLine(line: string): string | null {
  const match = line.match(CUSTOM_TITLE_RE);
  return match ? match[1].trim() : null;
}

function collectFencedLines(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let fenceCharacter = "";
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(
      /^\s*(?:>\s*)*(`{3,}|~{3,})/,
    );
    if (!fenceCharacter) {
      if (fenceMatch) {
        fenceCharacter = fenceMatch[1][0];
        fenceLength = fenceMatch[1].length;
        fenced.add(index);
      }
      continue;
    }

    fenced.add(index);
    if (
      fenceMatch &&
      fenceMatch[1][0] === fenceCharacter &&
      fenceMatch[1].length >= fenceLength
    ) {
      fenceCharacter = "";
      fenceLength = 0;
    }
  }

  return fenced;
}

function computeLineOffsets(markdown: string): number[] {
  const offsets = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function lineForOffset(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let answer = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] <= offset) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function stripQuotePrefixesFromFormula(inner: string): string {
  return inner.replace(/\r?\n\s*(?:>\s*)+/g, "\n");
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

function assignOccurrences(targets: ParsedSemanticTarget[]): void {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const count = (counts.get(target.lookupKey) ?? 0) + 1;
    counts.set(target.lookupKey, count);
    target.occurrence = count;
  }
}

function groupTargetIndexesByFingerprint(
  targets: ParsedSemanticTarget[],
  kind: SemanticTargetKind,
): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (let index = 0; index < targets.length; index += 1) {
    const fingerprint = targetFingerprint(targets[index], kind);
    const indexes = grouped.get(fingerprint) ?? [];
    indexes.push(index);
    grouped.set(fingerprint, indexes);
  }
  return grouped;
}

function targetFingerprint(
  target: ParsedSemanticTarget,
  kind: SemanticTargetKind,
): string {
  const content =
    kind === "formula"
      ? stripFormulaTag(target.markdown)
      : target.markdown.split(/\r?\n/).slice(1).join("\n");
  return content
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function pairNearestTargets(
  previous: ParsedSemanticTarget[],
  current: ParsedSemanticTarget[],
  previousIndexes: number[],
  currentIndexes: number[],
  previousMatched: Set<number>,
  currentMatched: Set<number>,
  pairs: Array<[number, number]>,
): void {
  const availablePrevious = previousIndexes.filter(
    (index) => !previousMatched.has(index),
  );
  const availableCurrent = currentIndexes.filter(
    (index) => !currentMatched.has(index),
  );

  while (
    availablePrevious.length > 0 &&
    availableCurrent.length > 0
  ) {
    let bestPreviousPosition = 0;
    let bestCurrentPosition = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (
      let previousPosition = 0;
      previousPosition < availablePrevious.length;
      previousPosition += 1
    ) {
      for (
        let currentPosition = 0;
        currentPosition < availableCurrent.length;
        currentPosition += 1
      ) {
        const distance = Math.abs(
          previous[availablePrevious[previousPosition]].lineStart -
            current[availableCurrent[currentPosition]].lineStart,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPreviousPosition = previousPosition;
          bestCurrentPosition = currentPosition;
        }
      }
    }

    const previousIndex = availablePrevious.splice(
      bestPreviousPosition,
      1,
    )[0];
    const currentIndex = availableCurrent.splice(
      bestCurrentPosition,
      1,
    )[0];
    previousMatched.add(previousIndex);
    currentMatched.add(currentIndex);
    pairs.push([previousIndex, currentIndex]);
  }
}

function rewriteSemanticWikiLinksInLine(
  line: string,
  rewrite: (
    link: ParsedWikiSemanticLink,
  ) => WikiSemanticLinkReplacement | null,
): WikiSemanticLinkRewriteResult {
  let cursor = 0;
  let output = "";
  let replacements = 0;

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const runLength = countCharacterRun(line, cursor, "`");
      const closing = line.indexOf(
        "`".repeat(runLength),
        cursor + runLength,
      );
      if (closing === -1) {
        output += line.slice(cursor);
        break;
      }
      output += line.slice(cursor, closing + runLength);
      cursor = closing + runLength;
      continue;
    }

    const embed = line.startsWith("![[", cursor);
    const regular = line.startsWith("[[", cursor);
    if (
      (!embed && !regular) ||
      isEscapedAt(line, cursor) ||
      (regular && cursor > 0 && line[cursor - 1] === "!")
    ) {
      output += line[cursor];
      cursor += 1;
      continue;
    }

    const openerLength = embed ? 3 : 2;
    const closing = line.indexOf("]]", cursor + openerLength);
    if (closing === -1) {
      output += line.slice(cursor);
      break;
    }

    const raw = line.slice(cursor, closing + 2);
    const inner = line.slice(cursor + openerLength, closing);
    const parsed = parseWikiSemanticLink(inner, embed);
    const replacement = parsed ? rewrite(parsed.link) : null;
    if (!parsed || !replacement) {
      output += raw;
      cursor = closing + 2;
      continue;
    }

    const alias =
      replacement.alias === undefined
        ? parsed.rawAlias
        : replacement.alias;
    output += `${embed ? "![[" : "[["}${parsed.rawLinkPath}#${encodeSemanticFragment(
      replacement.fragment,
    )}${alias === null ? "" : `|${alias}`}]]`;
    replacements += 1;
    cursor = closing + 2;
  }

  return {
    markdown: output,
    replacements,
  };
}

function parseWikiSemanticLink(
  inner: string,
  embed: boolean,
): {
  link: ParsedWikiSemanticLink;
  rawLinkPath: string;
  rawAlias: string | null;
} | null {
  const aliasIndex = firstUnescapedPipe(inner);
  const targetPart =
    aliasIndex === -1 ? inner : inner.slice(0, aliasIndex);
  const rawAlias =
    aliasIndex === -1 ? null : inner.slice(aliasIndex + 1);
  const hashIndex = targetPart.indexOf("#");
  if (hashIndex === -1) {
    return null;
  }
  const rawLinkPath = targetPart.slice(0, hashIndex);
  const fragment = targetPart.slice(hashIndex + 1).trim();
  if (!fragment) {
    return null;
  }
  return {
    link: {
      embed,
      linkPath: rawLinkPath.trim(),
      fragment,
      alias: rawAlias,
    },
    rawLinkPath,
    rawAlias,
  };
}

function countCharacterRun(
  value: string,
  start: number,
  character: string,
): number {
  let end = start;
  while (end < value.length && value[end] === character) {
    end += 1;
  }
  return end - start;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
