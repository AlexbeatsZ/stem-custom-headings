import {
  App,
  Component,
  Editor,
  finishRenderMath,
  Keymap,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  parseLinktext,
  Plugin,
  PluginSettingTab,
  renderMath,
  Setting,
  SuggestModal,
  TAbstractFile,
  TFile,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  encodeSemanticFragment,
  findFormulaReferenceByInlineOrdinal,
  findInlineSemanticTrigger,
  findSemanticTargetChanges,
  findWikiLinkAtOffset,
  FragmentRequest,
  makeFragmentForTarget,
  parseFormulaReferenceSource,
  ParsedSemanticTarget,
  parseFragmentRequest,
  parseSemanticNote,
  rewriteSemanticWikiLinks,
  SemanticTargetChange,
  SemanticTargetKind,
  stripFormulaTag,
} from "./reference-core";

declare const __STEM_PLUGIN_KIND__: SemanticTargetKind;

const PLUGIN_KIND = __STEM_PLUGIN_KIND__;
const IS_FORMULA_PLUGIN = PLUGIN_KIND === "formula";
const PLUGIN_NAME = IS_FORMULA_PLUGIN
  ? "公式编号引用"
  : "自制标题引用";
const EXPLICIT_LINK_CLASS = IS_FORMULA_PLUGIN
  ? "stem-formula-link"
  : "stem-custom-heading-link";
const EMBED_DATASET_KEY = IS_FORMULA_PLUGIN
  ? "stemFormulaEmbed"
  : "stemCustomHeadingEmbed";
const EMBED_CLASS = IS_FORMULA_PLUGIN
  ? "stem-formula-embed"
  : "stem-custom-heading-embed";
let suggestionMathFlushScheduled = false;

interface SemanticLinksSettings {
  hoverDelayMs: number;
  previewMaxLines: number;
  autoSyncReferences: boolean;
  autoFormulaLinks: boolean;
  includeTitleInEmbed: boolean;
  showTagInCrossFileEmbed: boolean;
}

const DEFAULT_SETTINGS: SemanticLinksSettings = {
  hoverDelayMs: 300,
  previewMaxLines: 40,
  autoSyncReferences: true,
  autoFormulaLinks: true,
  includeTitleInEmbed: true,
  showTagInCrossFileEmbed: false,
};

interface IndexedTarget extends ParsedSemanticTarget {
  file: TFile;
  path: string;
}

interface IndexedNote {
  file: TFile;
  subheadings: IndexedTarget[];
  formulas: IndexedTarget[];
}

interface IndexUpdateResult {
  previous: IndexedNote | null;
  current: IndexedNote | null;
}

interface PendingFileUpdate {
  timer: number;
  suppressSync: boolean;
}

interface ResolvedReference {
  target: IndexedTarget;
  sourcePath: string;
}

type ReferenceInsertMode = "inline" | "link" | "embed";

class SemanticReferenceIndex {
  private notes = new Map<string, IndexedNote>();
  private buildPromise: Promise<void> = Promise.resolve();

  constructor(private app: App) {}

  rebuildAll(): Promise<void> {
    this.buildPromise = this.performFullBuild();
    return this.buildPromise;
  }

  whenReady(): Promise<void> {
    return this.buildPromise;
  }

  async updateFile(file: TFile): Promise<IndexUpdateResult> {
    const previous = this.notes.get(file.path) ?? null;
    if (this.shouldIgnore(file.path)) {
      this.notes.delete(file.path);
      return { previous, current: null };
    }
    const markdown = await this.app.vault.cachedRead(file);
    const parsed = parseSemanticNote(markdown);
    const attach = (target: ParsedSemanticTarget): IndexedTarget => ({
      ...target,
      file,
      path: file.path,
    });
    const current: IndexedNote = {
      file,
      subheadings: parsed.subheadings.map(attach),
      formulas: parsed.formulas.map(attach),
    };
    this.notes.set(file.path, current);
    return { previous, current };
  }

  removePath(path: string): void {
    this.notes.delete(path);
  }

  getTarget(
    file: TFile,
    request: FragmentRequest,
  ): IndexedTarget | null {
    const note = this.notes.get(file.path);
    if (!note) {
      return null;
    }
    const targets =
      request.kind === "formula" ? note.formulas : note.subheadings;
    const primary =
      targets.find(
        (target) =>
          target.lookupKey === request.lookupKey &&
          target.occurrence === request.occurrence,
      ) ?? null;
    if (primary || !request.fallback) {
      return primary;
    }
    return (
      targets.find(
        (target) =>
          target.lookupKey === request.fallback?.lookupKey &&
          target.occurrence === request.fallback?.occurrence,
      ) ?? null
    );
  }

  getTargetByIdentity(
    path: string,
    kind: SemanticTargetKind,
    lookupKey: string,
    occurrence: number,
  ): IndexedTarget | null {
    const note = this.notes.get(path);
    if (!note) {
      return null;
    }
    const targets = kind === "formula" ? note.formulas : note.subheadings;
    return (
      targets.find(
        (target) =>
          target.lookupKey === lookupKey &&
          target.occurrence === occurrence,
      ) ?? null
    );
  }

  getTargets(
    kind: SemanticTargetKind,
    currentPath: string,
  ): IndexedTarget[] {
    const targets: IndexedTarget[] = [];
    for (const note of this.notes.values()) {
      targets.push(
        ...(kind === "formula" ? note.formulas : note.subheadings),
      );
    }
    return targets.sort((left, right) => {
      const leftCurrent = left.path === currentPath ? 0 : 1;
      const rightCurrent = right.path === currentPath ? 0 : 1;
      if (leftCurrent !== rightCurrent) {
        return leftCurrent - rightCurrent;
      }
      const pathOrder = left.path.localeCompare(right.path, "zh-CN");
      return pathOrder !== 0
        ? pathOrder
        : left.lineStart - right.lineStart;
    });
  }

  getTargetsInFile(
    kind: SemanticTargetKind,
    path: string,
  ): IndexedTarget[] {
    const note = this.notes.get(path);
    if (!note) {
      return [];
    }
    return kind === "formula"
      ? [...note.formulas]
      : [...note.subheadings];
  }

  private async performFullBuild(): Promise<void> {
    const nextNotes = new Map<string, IndexedNote>();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.shouldIgnore(file.path));

    await mapWithConcurrency(files, 12, async (file) => {
      try {
        const markdown = await this.app.vault.cachedRead(file);
        const parsed = parseSemanticNote(markdown);
        const attach = (target: ParsedSemanticTarget): IndexedTarget => ({
          ...target,
          file,
          path: file.path,
        });
        nextNotes.set(file.path, {
          file,
          subheadings: parsed.subheadings.map(attach),
          formulas: parsed.formulas.map(attach),
        });
      } catch (error) {
        console.error(
          `[${PLUGIN_NAME}] 无法索引 ${file.path}`,
          error,
        );
      }
    });

    this.notes = nextNotes;
  }

  private shouldIgnore(path: string): boolean {
    return path.startsWith(".trash/") || path.startsWith(".obsidian/");
  }
}

class TargetSuggestModal extends SuggestModal<IndexedTarget> {
  private candidates: IndexedTarget[];

  constructor(
    app: App,
    candidates: IndexedTarget[],
    kind: SemanticTargetKind,
    private onChooseTarget: (target: IndexedTarget) => void,
    private onClosePicker?: () => void,
  ) {
    super(app);
    this.candidates = candidates;
    this.limit = 80;
    this.emptyStateText = "没有找到匹配的语义目标";
    this.setPlaceholder(
      kind === "formula"
        ? "搜索公式、编号或文件名…"
        : "搜索自制标题或文件名…",
    );
  }

  getSuggestions(query: string): IndexedTarget[] {
    return filterTargets(this.candidates, query, this.limit);
  }

  renderSuggestion(target: IndexedTarget, el: HTMLElement): void {
    renderTargetSuggestion(target, el);
  }

  onChooseSuggestion(target: IndexedTarget): void {
    this.onChooseTarget(target);
    this.close();
  }

  onClose(): void {
    this.onClosePicker?.();
  }
}

class SemanticLinksSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: StemSemanticLinksPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: PLUGIN_NAME });

    new Setting(containerEl)
      .setName("悬停预览延迟")
      .setDesc("鼠标停留多久后打开语义预览卡片，单位为毫秒。")
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.hoverDelayMs))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              this.plugin.settings.hoverDelayMs = Math.max(
                0,
                Math.min(2000, Math.round(parsed)),
              );
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("悬停预览最大行数")
      .setDesc("只限制悬停卡片；显式嵌入仍显示完整语义段落。")
      .addText((text) =>
        text
          .setPlaceholder("40")
          .setValue(String(this.plugin.settings.previewMaxLines))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              this.plugin.settings.previewMaxLines = Math.max(
                5,
                Math.min(300, Math.round(parsed)),
              );
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("自动同步引用")
      .setDesc(
        IS_FORMULA_PLUGIN
          ? "修改公式的 \\tag 编号后，自动更新 Vault 内指向它的 #= 链接与嵌入。"
          : "修改自制标题名称后，自动更新 Vault 内指向它的 #- 链接与嵌入。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncReferences)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncReferences = value;
            await this.plugin.saveSettings();
          }),
      );

    if (IS_FORMULA_PLUGIN) {
      new Setting(containerEl)
        .setName("自动增强正文编号")
        .setDesc("只把 $\\text{(1-7)}$ 这种严格格式渲染成蓝链。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.autoFormulaLinks)
            .onChange(async (value) => {
              this.plugin.settings.autoFormulaLinks = value;
              await this.plugin.saveSettings();
              this.plugin.refreshFormulaLinkStyles();
            }),
        );
      new Setting(containerEl)
        .setName("跨文件嵌入显示原编号")
        .setDesc(
          "默认关闭：![[另一篇#=(9-9)]] 只显示公式本体，避免把原笔记编号混入当前文章。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(
              this.plugin.settings.showTagInCrossFileEmbed,
            )
            .onChange(async (value) => {
              this.plugin.settings.showTagInCrossFileEmbed = value;
              await this.plugin.saveSettings();
              this.plugin.refreshSemanticEmbeds();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("嵌入时显示自制标题行")
        .setDesc("关闭后，![[#-标题]] 只嵌入标题下面的正文。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.includeTitleInEmbed)
            .onChange(async (value) => {
              this.plugin.settings.includeTitleInEmbed = value;
              await this.plugin.saveSettings();
            }),
        );
    }
  }
}

export default class StemSemanticLinksPlugin extends Plugin {
  settings: SemanticLinksSettings = DEFAULT_SETTINGS;
  private index!: SemanticReferenceIndex;
  private modifyTimers = new Map<string, PendingFileUpdate>();
  private selfWritePaths = new Set<string>();
  private observer: MutationObserver | null = null;
  private scanFrame: number | null = null;
  private pendingScanRoots = new Set<Element>();
  private hoverOpenTimer: number | null = null;
  private hoverCloseTimer: number | null = null;
  private hoverAnchor: HTMLElement | null = null;
  private popoverEl: HTMLElement | null = null;
  private popoverComponent: Component | null = null;
  private isActive = false;
  private inlineTriggerKey: string | null = null;

  async onload(): Promise<void> {
    this.isActive = true;
    await this.loadSettings();
    this.index = new SemanticReferenceIndex(this.app);
    const initialBuild = this.index.rebuildAll();

    this.registerMarkdownPostProcessor(async (el, ctx) => {
      await this.index.whenReady();
      this.enhanceElementTree(el, ctx.sourcePath);
      await this.renderSemanticEmbeds(
        el,
        ctx.sourcePath,
        (child) => ctx.addChild(child),
      );
    }, 50);

    this.registerVaultEvents();
    this.registerCommands();
    this.addSettingTab(new SemanticLinksSettingTab(this.app, this));
    this.registerInteractionHandlers();
    this.registerLivePreviewScanning();

    void initialBuild.then(() => {
      if (!this.isActive) {
        return;
      }
      this.startObserver();
      this.refreshSemanticEmbeds();
      this.scheduleScan(document.body);
    });

    this.register(() => {
      this.isActive = false;
      this.observer?.disconnect();
      this.observer = null;
      if (this.scanFrame !== null) {
        window.cancelAnimationFrame(this.scanFrame);
      }
      for (const pending of this.modifyTimers.values()) {
        window.clearTimeout(pending.timer);
      }
      this.modifyTimers.clear();
      this.selfWritePaths.clear();
      this.closePopover();
      this.clearAllEnhancedElements();
    });
  }

  onunload(): void {
    this.isActive = false;
    this.closePopover();
    this.clearAllEnhancedElements();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshFormulaLinkStyles(): void {
    if (!IS_FORMULA_PLUGIN) {
      return;
    }
    if (!this.settings.autoFormulaLinks) {
      this.clearAllFormulaReferences();
      return;
    }
    this.scheduleScan(document.body);
  }

  refreshSemanticEmbeds(): void {
    document
      .querySelectorAll<HTMLElement>(`.${EMBED_CLASS}`)
      .forEach((embed) => {
        delete embed.dataset[EMBED_DATASET_KEY];
        this.scheduleScan(embed);
      });
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.queueFileUpdate(
            file,
            this.selfWritePaths.has(file.path),
          );
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.queueFileUpdate(file, false);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.index.removePath(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on(
        "rename",
        (file: TAbstractFile, oldPath: string) => {
          this.index.removePath(oldPath);
          if (file instanceof TFile && file.extension === "md") {
            this.queueFileUpdate(file, false);
          }
        },
      ),
    );
  }

  private registerCommands(): void {
    if (IS_FORMULA_PLUGIN) {
      this.addCommand({
        id: "insert-inline-formula-reference",
        name: "插入正文公式编号引用",
        editorCallback: (editor, view) => {
          void this.openTargetPicker("inline", editor, view.file);
        },
      });
      this.addCommand({
        id: "insert-explicit-formula-link",
        name: "插入显式公式链接",
        editorCallback: (editor, view) => {
          void this.openTargetPicker("link", editor, view.file);
        },
      });
      this.addCommand({
        id: "insert-formula-embed",
        name: "插入公式嵌入",
        editorCallback: (editor, view) => {
          void this.openTargetPicker("embed", editor, view.file);
        },
      });
    } else {
      this.addCommand({
        id: "insert-custom-heading-reference",
        name: "插入自制标题引用",
        editorCallback: (editor, view) => {
          void this.openTargetPicker("link", editor, view.file);
        },
      });
      this.addCommand({
        id: "insert-custom-heading-embed",
        name: "插入自制标题嵌入",
        editorCallback: (editor, view) => {
          void this.openTargetPicker("embed", editor, view.file);
        },
      });
    }
    this.addCommand({
      id: "rebuild-semantic-reference-index",
      name: "重建引用索引",
      callback: async () => {
        const notice = new Notice(`正在重建${PLUGIN_NAME}索引…`, 0);
        await this.index.rebuildAll();
        notice.hide();
        this.scheduleScan(document.body);
        new Notice(`${PLUGIN_NAME}索引已重建`);
      },
    });
  }

  private registerInteractionHandlers(): void {
    this.registerDomEvent(
      document,
      "click",
      (event) => {
        const element = this.closestReferenceElement(event.target);
        if (!element) {
          return;
        }
        const reference = this.resolveElementReference(element);
        if (!reference) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        this.closePopover();
        void this.navigateToTarget(
          reference.target,
          reference.sourcePath,
          event,
        );
      },
      true,
    );

    this.registerDomEvent(
      document,
      "mouseover",
      (event) => {
        const element = this.closestReferenceElement(event.target);
        if (!element || element.closest(".stem-semantic-popover")) {
          return;
        }
        const fromElement = asElement(event.relatedTarget);
        if (fromElement && element.contains(fromElement)) {
          return;
        }
        const reference = this.resolveElementReference(element);
        if (!reference) {
          return;
        }
        this.cancelHoverClose();
        this.schedulePopover(element, reference);
      },
      true,
    );

    this.registerDomEvent(
      document,
      "mouseout",
      (event) => {
        const element = this.closestReferenceElement(event.target);
        if (!element) {
          return;
        }
        const toElement = asElement(event.relatedTarget);
        if (
          (toElement && element.contains(toElement)) ||
          (toElement && this.popoverEl?.contains(toElement))
        ) {
          return;
        }
        this.schedulePopoverClose();
      },
      true,
    );

    this.registerDomEvent(
      document,
      "keydown",
      (event) => {
        if (
          event.key !== "Enter" &&
          event.key !== " "
        ) {
          return;
        }
        const element = this.closestReferenceElement(event.target);
        if (!element) {
          return;
        }
        const reference = this.resolveElementReference(element);
        if (!reference) {
          return;
        }
        event.preventDefault();
        void this.navigateToTarget(
          reference.target,
          reference.sourcePath,
          event,
        );
      },
      true,
    );
  }

  private async openTargetPicker(
    mode: ReferenceInsertMode,
    editor: Editor,
    sourceFile: TFile | null,
  ): Promise<void> {
    if (!sourceFile) {
      new Notice("当前没有活动 Markdown 文件");
      return;
    }
    await this.index.whenReady();
    let candidates = this.index.getTargets(
      PLUGIN_KIND,
      sourceFile.path,
    );
    if (mode === "inline") {
      candidates = candidates.filter(
        (target) => target.path === sourceFile.path,
      );
    }
    if (candidates.length === 0) {
      new Notice(
        IS_FORMULA_PLUGIN
          ? "Vault 中没有找到带 \\tag 的公式"
          : "Vault 中没有找到 > **标题**",
      );
      return;
    }

    new TargetSuggestModal(
      this.app,
      candidates,
      PLUGIN_KIND,
      (target) => {
        const reference =
          mode === "inline"
            ? `$\\text{(${target.label})}$`
            : this.formatWikiReference(
                target,
                sourceFile.path,
                mode === "embed",
              );
        editor.replaceSelection(reference);
      },
    ).open();
  }

  private formatWikiReference(
    target: IndexedTarget,
    sourcePath: string,
    embed: boolean,
  ): string {
    const rawFragment = makeFragmentForTarget(target);
    const fragment = encodeSemanticFragment(rawFragment);
    const sameFile = target.path === sourcePath;
    const filePart = sameFile
      ? ""
      : this.app.metadataCache.fileToLinktext(
          target.file,
          sourcePath,
          true,
        );
    const prefix = embed ? "![[" : "[[";
    const label =
      targetReferenceLabel(target);
    const alias = embed ? "" : `|${escapeWikiAlias(label)}`;
    return `${prefix}${filePart}#${fragment}${alias}]]`;
  }

  private queueFileUpdate(
    file: TFile,
    suppressSync: boolean,
  ): void {
    const existing = this.modifyTimers.get(file.path);
    if (existing) {
      window.clearTimeout(existing.timer);
    }
    const shouldSuppressSync = existing
      ? existing.suppressSync && suppressSync
      : suppressSync;
    const timer = window.setTimeout(() => {
      this.modifyTimers.delete(file.path);
      void this.processFileUpdate(file, shouldSuppressSync);
    }, 500);
    this.modifyTimers.set(file.path, {
      timer,
      suppressSync: shouldSuppressSync,
    });
  }

  private async processFileUpdate(
    file: TFile,
    suppressSync: boolean,
  ): Promise<void> {
    try {
      await this.index.whenReady();
      const update = await this.index.updateFile(file);
      if (
        this.settings.autoSyncReferences &&
        !suppressSync &&
        update.previous &&
        update.current
      ) {
        const previousTargets = IS_FORMULA_PLUGIN
          ? update.previous.formulas
          : update.previous.subheadings;
        const currentTargets = IS_FORMULA_PLUGIN
          ? update.current.formulas
          : update.current.subheadings;
        const changes = findSemanticTargetChanges(
          previousTargets,
          currentTargets,
          PLUGIN_KIND,
        );
        if (changes.length > 0) {
          await this.synchronizeReferences(file, changes);
        }
      }
      this.scheduleScan(document.body);
    } catch (error) {
      console.error(
        `[${PLUGIN_NAME}] 无法更新 ${file.path}`,
        error,
      );
    }
  }

  private async synchronizeReferences(
    targetFile: TFile,
    changes: SemanticTargetChange[],
  ): Promise<void> {
    const changesByIdentity = new Map<string, SemanticTargetChange>();
    for (const change of changes) {
      changesByIdentity.set(
        semanticTargetIdentity(
          change.previous.kind,
          change.previous.lookupKey,
          change.previous.occurrence,
        ),
        change,
      );
    }

    await enqueueGlobalReferenceSync(async () => {
      if (!this.isActive) {
        return;
      }
      let replacementCount = 0;
      let changedFileCount = 0;
      const marker = IS_FORMULA_PLUGIN ? "#=" : "#-";
      const files = this.app.vault
        .getMarkdownFiles()
        .filter(
          (file) =>
            !file.path.startsWith(".trash/") &&
            !file.path.startsWith(".obsidian/"),
        );

      await mapWithConcurrency(files, 6, async (sourceFile) => {
        try {
          const cached = await this.app.vault.cachedRead(sourceFile);
          if (!cached.includes(marker)) {
            return;
          }
          const preview = this.rewriteReferencesInMarkdown(
            cached,
            sourceFile,
            targetFile,
            changesByIdentity,
          );
          if (preview.replacements === 0) {
            return;
          }

          let actualReplacements = 0;
          this.selfWritePaths.add(sourceFile.path);
          try {
            await this.app.vault.process(
              sourceFile,
              (currentMarkdown) => {
                const rewritten = this.rewriteReferencesInMarkdown(
                  currentMarkdown,
                  sourceFile,
                  targetFile,
                  changesByIdentity,
                );
                actualReplacements = rewritten.replacements;
                return rewritten.markdown;
              },
            );
          } finally {
            this.selfWritePaths.delete(sourceFile.path);
          }
          if (actualReplacements > 0) {
            replacementCount += actualReplacements;
            changedFileCount += 1;
          }
        } catch (error) {
          console.error(
            `[${PLUGIN_NAME}] 无法同步 ${sourceFile.path}`,
            error,
          );
        }
      });

      if (replacementCount > 0) {
        const referenceName = IS_FORMULA_PLUGIN
          ? "公式引用"
          : "自制标题引用";
        new Notice(
          `已同步 ${replacementCount} 个${referenceName}（${changedFileCount} 篇笔记）`,
        );
      }
    });
  }

  private rewriteReferencesInMarkdown(
    markdown: string,
    sourceFile: TFile,
    targetFile: TFile,
    changesByIdentity: Map<string, SemanticTargetChange>,
  ): {
    markdown: string;
    replacements: number;
  } {
    return rewriteSemanticWikiLinks(markdown, (link) => {
      const request = parseFragmentRequest(link.fragment);
      if (!request || request.kind !== PLUGIN_KIND) {
        return null;
      }
      const resolvedFile = link.linkPath
        ? this.app.metadataCache.getFirstLinkpathDest(
            link.linkPath,
            sourceFile.path,
          )
        : sourceFile;
      if (!resolvedFile || resolvedFile.path !== targetFile.path) {
        return null;
      }

      let change = changesByIdentity.get(
        semanticTargetIdentity(
          request.kind,
          request.lookupKey,
          request.occurrence,
        ),
      );
      if (!change && request.fallback) {
        change = changesByIdentity.get(
          semanticTargetIdentity(
            request.kind,
            request.fallback.lookupKey,
            request.fallback.occurrence,
          ),
        );
      }
      if (!change) {
        return null;
      }

      const previousAlias = targetReferenceLabel(change.previous);
      const currentAlias = targetReferenceLabel(change.current);
      const alias =
        link.alias !== null &&
        unescapeWikiAlias(link.alias) === previousAlias
          ? escapeWikiAlias(currentAlias)
          : undefined;
      return {
        fragment: makeFragmentForTarget(change.current),
        alias,
      };
    });
  }

  private startObserver(): void {
    if (this.observer) {
      return;
    }
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          const parent = record.target.parentElement;
          if (parent) {
            this.scheduleScan(
              parent.closest(".internal-embed") ??
                parent.closest("span.math") ??
                parent,
            );
          }
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) {
            this.scheduleScan(
              node.closest(".internal-embed") ?? node,
            );
          } else if (node.parentElement) {
            this.scheduleScan(
              node.parentElement.closest(".internal-embed") ??
                node.parentElement,
            );
          }
        }
      }
    });
    this.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  private registerLivePreviewScanning(): void {
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged
        ) {
          this.scheduleScan(update.view.dom);
        }
        if (update.docChanged) {
          this.maybeOpenInlineTargetPicker(update.view);
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleScan(document.body);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleScan(document.body);
      }),
    );
    this.registerDomEvent(window, "resize", () => {
      this.scheduleScan(document.body);
    });
  }

  private maybeOpenInlineTargetPicker(view: EditorView): void {
    const selection = view.state.selection.main;
    if (!selection.empty) {
      this.inlineTriggerKey = null;
      return;
    }
    const line = view.state.doc.lineAt(selection.head);
    const beforeCursor = line.text.slice(
      0,
      selection.head - line.from,
    );
    const namespace = IS_FORMULA_PLUGIN ? "=" : "-";
    const trigger = findInlineSemanticTrigger(
      beforeCursor,
      namespace,
    );
    if (!trigger) {
      this.inlineTriggerKey = null;
      return;
    }

    const sourceFile = this.fileForEditorView(view);
    if (!sourceFile) {
      return;
    }
    const insertAt = selection.head;
    const triggerKey =
      `${sourceFile.path}:${insertAt}:${trigger.linkPath}:${namespace}`;
    if (triggerKey === this.inlineTriggerKey) {
      return;
    }
    this.inlineTriggerKey = triggerKey;
    window.setTimeout(() => {
      if (!this.isActive) {
        return;
      }
      void this.openInlineTargetPicker(
        view,
        sourceFile,
        insertAt,
        trigger.linkPath,
      );
    }, 0);
  }

  private async openInlineTargetPicker(
    view: EditorView,
    sourceFile: TFile,
    insertAt: number,
    linkPath: string,
  ): Promise<void> {
    await this.index.whenReady();
    if (!this.isActive) {
      return;
    }
    const targetFile = linkPath
      ? this.app.metadataCache.getFirstLinkpathDest(
          linkPath,
          sourceFile.path,
        )
      : sourceFile;
    if (!targetFile) {
      return;
    }
    const candidates = this.index.getTargetsInFile(
      PLUGIN_KIND,
      targetFile.path,
    );
    if (candidates.length === 0) {
      return;
    }
    new TargetSuggestModal(
      this.app,
      candidates,
      PLUGIN_KIND,
      (target) => {
        const insertion = encodeSemanticFragment(
          makeFragmentForTarget(target).slice(1),
        );
        view.dispatch({
          changes: {
            from: insertAt,
            to: insertAt,
            insert: insertion,
          },
          selection: {
            anchor: insertAt + insertion.length,
          },
        });
        this.inlineTriggerKey = null;
        view.focus();
      },
      () => {
        this.inlineTriggerKey = null;
      },
    ).open();
  }

  private fileForEditorView(view: EditorView): TFile | null {
    let file: TFile | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        file ||
        !(leaf.view instanceof MarkdownView) ||
        !leaf.view.file
      ) {
        return;
      }
      const editorView = (
        leaf.view.editor as unknown as {
          cm?: EditorView;
        }
      ).cm;
      if (editorView === view) {
        file = leaf.view.file;
      }
    });
    return file;
  }

  private scheduleScan(root: Element): void {
    this.pendingScanRoots.add(
      root.closest(".internal-embed") ?? root,
    );
    if (this.scanFrame !== null) {
      return;
    }
    this.scanFrame = window.requestAnimationFrame(() => {
      this.scanFrame = null;
      const roots = Array.from(this.pendingScanRoots);
      this.pendingScanRoots.clear();
      for (const scanRoot of roots) {
        this.enhanceElementTree(scanRoot);
        void this.renderSemanticEmbeds(
          scanRoot,
          undefined,
          (child) => this.addChild(child),
        );
      }
    });
  }

  private enhanceElementTree(
    root: Element,
    knownSourcePath?: string,
  ): void {
    for (const link of collectMatches<HTMLAnchorElement>(
      root,
      "a.internal-link",
    )) {
      const sourcePath =
        knownSourcePath ?? this.findSourcePathForElement(link);
      if (sourcePath) {
        this.enhanceInternalLink(link, sourcePath);
      }
    }

    if (!IS_FORMULA_PLUGIN || !this.settings.autoFormulaLinks) {
      return;
    }
    for (const formula of collectMatches<HTMLElement>(
      root,
      "span.math",
    )) {
      const sourcePath =
        knownSourcePath ?? this.findSourcePathForElement(formula);
      if (sourcePath) {
        this.enhanceFormulaReference(formula, sourcePath);
      }
    }
  }

  private enhanceInternalLink(
    link: HTMLAnchorElement,
    sourcePath: string,
  ): void {
    const linktext =
      link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
    const target = this.resolveLinktext(linktext, sourcePath);
    if (!target) {
      if (link.hasClass(EXPLICIT_LINK_CLASS)) {
        this.clearExplicitLink(link);
      }
      return;
    }
    link.addClass(EXPLICIT_LINK_CLASS);
    link.removeClass("is-unresolved");
    link.dataset.stemSourcePath = sourcePath;
    this.writeTargetDataset(link, target);
  }

  private enhanceFormulaReference(
    formula: HTMLElement,
    sourcePath: string,
  ): void {
    if (formula.closest("a")) {
      this.clearFormulaReference(formula);
      return;
    }
    let tag = this.formulaTagFromMathJax(formula);
    tag ??= this.formulaTagFromPreview(formula, sourcePath);
    tag ??= this.formulaTagFromEditor(formula, sourcePath);
    if (!tag) {
      this.clearFormulaReference(formula);
      return;
    }
    const file = this.fileAtPath(sourcePath);
    if (!file) {
      this.clearFormulaReference(formula);
      return;
    }
    const request: FragmentRequest = {
      kind: "formula",
      lookupKey: tag,
      occurrence: 1,
      label: `(${tag})`,
    };
    const target = this.index.getTarget(file, request);
    if (!target) {
      this.clearFormulaReference(formula);
      return;
    }
    formula.addClass("stem-semantic-formula-ref");
    formula.setAttr("role", "link");
    formula.setAttr("tabindex", "0");
    formula.dataset.stemSourcePath = sourcePath;
    this.writeTargetDataset(formula, target);
  }

  private formulaTagFromMathJax(
    formula: HTMLElement,
  ): string | null {
    const mathJax = (
      window as typeof window & {
        MathJax?: {
          startup?: {
            document?: {
              getMathItemsWithin?: (
                containers: HTMLElement | HTMLElement[],
              ) => Iterable<{ math?: string }> | ArrayLike<{
                math?: string;
              }>;
            };
          };
        };
      }
    ).MathJax;
    const getMathItemsWithin =
      mathJax?.startup?.document?.getMathItemsWithin;
    if (!getMathItemsWithin) {
      return null;
    }

    for (const containers of [[formula], formula]) {
      try {
        const found = getMathItemsWithin.call(
          mathJax.startup?.document,
          containers,
        );
        const items = Array.from(found ?? []) as Array<{
          math?: string;
        }>;
        for (const item of items) {
          const tag = parseFormulaReferenceSource(item.math ?? "");
          if (tag) {
            return tag;
          }
        }
      } catch {
        // Different MathJax builds accept different container shapes.
      }
    }
    return null;
  }

  private formulaTagFromEditor(
    formula: HTMLElement,
    sourcePath: string,
  ): string | null {
    let tag: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        tag ||
        !(leaf.view instanceof MarkdownView) ||
        leaf.view.file?.path !== sourcePath ||
        !leaf.view.containerEl.contains(formula)
      ) {
        return;
      }

      const editorView = (
        leaf.view.editor as unknown as {
          cm?: {
            posAtDOM?: (node: Node, offset?: number) => number;
            state?: {
              doc?: {
                lineAt?: (
                  position: number,
                ) => {
                  number: number;
                };
                toString?: () => string;
              };
            };
          };
        }
      ).cm;
      const markdown = editorView?.state?.doc?.toString?.();
      if (!editorView?.posAtDOM || markdown === undefined) {
        return;
      }

      const callout = formula.closest<HTMLElement>(
        ".cm-embed-block.cm-callout",
      );
      if (callout && leaf.view.containerEl.contains(callout)) {
        try {
          const position = editorView.posAtDOM(formula, 0);
          const lineNumber =
            editorView.state?.doc?.lineAt?.(position).number;
          if (lineNumber !== undefined) {
            const lines = markdown.split(/\r?\n/);
            const lineStart = Math.max(0, lineNumber - 1);
            let lineEnd = lineStart;
            while (
              lineEnd + 1 < lines.length &&
              /^\s*>/.test(lines[lineEnd + 1])
            ) {
              lineEnd += 1;
            }
            const ordinal = Array.from(
              callout.querySelectorAll<HTMLElement>(
                "span.math",
              ),
            ).indexOf(formula);
            tag = findFormulaReferenceByInlineOrdinal(
              markdown,
              lineStart,
              lineEnd,
              ordinal,
            );
          }
        } catch {
          // An unmappable formula is not considered a reference.
        }
        return;
      }

      const editorLine = formula.closest<HTMLElement>(".cm-line");
      if (editorLine && leaf.view.containerEl.contains(editorLine)) {
        try {
          const position = editorView.posAtDOM(editorLine, 0);
          const lineNumber =
            editorView.state?.doc?.lineAt?.(position).number;
          if (lineNumber !== undefined) {
            const ordinal = Array.from(
              editorLine.querySelectorAll<HTMLElement>(
                "span.math",
              ),
            ).indexOf(formula);
            tag = findFormulaReferenceByInlineOrdinal(
              markdown,
              lineNumber - 1,
              lineNumber - 1,
              ordinal,
            );
          }
        } catch {
          // An unmappable formula is not considered a reference.
        }
        return;
      }
    });
    return tag;
  }

  private formulaTagFromPreview(
    formula: HTMLElement,
    sourcePath: string,
  ): string | null {
    let tag: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        tag ||
        !(leaf.view instanceof MarkdownView) ||
        leaf.view.file?.path !== sourcePath ||
        !leaf.view.previewMode.containerEl.contains(formula)
      ) {
        return;
      }

      const lineElement = formula.closest<HTMLElement>("[data-line]");
      if (
        !lineElement ||
        !leaf.view.previewMode.containerEl.contains(lineElement)
      ) {
        return;
      }
      const lineStart = Number(lineElement.dataset.line);
      if (!Number.isInteger(lineStart) || lineStart < 0) {
        return;
      }

      const followingLines = Array.from(
        leaf.view.previewMode.containerEl.querySelectorAll<HTMLElement>(
          "[data-line]",
        ),
      )
        .map((element) => Number(element.dataset.line))
        .filter(
          (line) => Number.isInteger(line) && line > lineStart,
        );
      const nextLine =
        followingLines.length > 0
          ? Math.min(...followingLines)
          : Number.POSITIVE_INFINITY;
      const markdown = leaf.view.getViewData();
      const lineCount = markdown.split(/\r?\n/).length;
      const lineEnd = Number.isFinite(nextLine)
        ? Math.max(lineStart, nextLine - 1)
        : lineCount - 1;
      const formulas = Array.from(
        lineElement.querySelectorAll<HTMLElement>(
          "span.math",
        ),
      );
      const ordinal = formulas.indexOf(formula);
      tag = findFormulaReferenceByInlineOrdinal(
        markdown,
        lineStart,
        lineEnd,
        ordinal,
      );
    });
    return tag;
  }

  private async renderSemanticEmbeds(
    root: Element,
    knownSourcePath?: string,
    registerChild: (
      child: MarkdownRenderChild,
    ) => void = (child) => this.addChild(child),
  ): Promise<void> {
    await this.index.whenReady();
    const embedScanRoot =
      root.closest(".internal-embed") ?? root;
    const embeds = collectMatches<HTMLElement>(
      embedScanRoot,
      ".internal-embed",
    );
    for (const embed of embeds) {
      if (embed.dataset[EMBED_DATASET_KEY] === "true") {
        continue;
      }
      const linktext =
        embed.getAttribute("src") ??
        embed.getAttribute("data-content") ??
        embed.getAttribute("data-href") ??
        "";
      const parsedLink = parseLinktext(linktext);
      const hostSourcePath = this.findSourcePathForElement(embed);
      const sourcePath =
        knownSourcePath ?? hostSourcePath;
      if (!sourcePath) {
        continue;
      }
      const target = this.resolveLinktext(linktext, sourcePath);
      if (!target) {
        continue;
      }
      const isCrossFile =
        parsedLink.path.trim().length > 0 ||
        (hostSourcePath !== null &&
          target.path !== hostSourcePath);

      embed.dataset[EMBED_DATASET_KEY] = "true";
      embed.empty();
      embed.addClasses([
        "stem-semantic-embed",
        EMBED_CLASS,
      ]);
      embed.removeClass("is-unresolved");
      const body = embed.createDiv("stem-semantic-embed__body");
      body.addClass("markdown-rendered");
      const child = new MarkdownRenderChild(body);
      registerChild(child);
      let markdown = target.markdown;
      if (
        target.kind === "formula" &&
        isCrossFile &&
        !this.settings.showTagInCrossFileEmbed
      ) {
        markdown = stripFormulaTag(markdown);
      }
      if (
        target.kind === "subheading" &&
        !this.settings.includeTitleInEmbed
      ) {
        markdown = markdown.split(/\r?\n/).slice(1).join("\n");
      }
      await MarkdownRenderer.render(
        this.app,
        markdown,
        body,
        target.path,
        child,
      );
    }
  }

  private resolveLinktext(
    linktext: string,
    sourcePath: string,
  ): IndexedTarget | null {
    if (!linktext || /^(?:https?:|mailto:|obsidian:)/i.test(linktext)) {
      return null;
    }
    const parsed = parseLinktext(linktext);
    const request = parseFragmentRequest(parsed.subpath);
    if (!request || request.kind !== PLUGIN_KIND) {
      return null;
    }
    const targetFile = parsed.path
      ? this.app.metadataCache.getFirstLinkpathDest(
          parsed.path,
          sourcePath,
        )
      : this.fileAtPath(sourcePath);
    if (!targetFile) {
      return null;
    }

    return this.index.getTarget(targetFile, request);
  }

  private fileAtPath(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private findSourcePathForElement(element: Element): string | null {
    const dataSource = (element as HTMLElement).dataset?.stemSourcePath;
    if (dataSource) {
      return dataSource;
    }
    let sourcePath: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        !sourcePath &&
        leaf.view.containerEl.contains(element) &&
        leaf.view instanceof MarkdownView &&
        leaf.view.file
      ) {
        sourcePath = leaf.view.file.path;
      }
    });
    return sourcePath;
  }

  private closestReferenceElement(
    target: EventTarget | null,
  ): HTMLElement | null {
    const element = asElement(target);
    const selector = IS_FORMULA_PLUGIN
      ? `a.internal-link, .cm-hmd-internal-link, .${EXPLICIT_LINK_CLASS}, .stem-semantic-formula-ref`
      : `a.internal-link, .cm-hmd-internal-link, .${EXPLICIT_LINK_CLASS}`;
    return (
      element?.closest<HTMLElement>(selector) ?? null
    );
  }

  private resolveElementReference(
    element: HTMLElement,
  ): ResolvedReference | null {
    const sourcePath =
      element.dataset.stemSourcePath ??
      this.findSourcePathForElement(element);
    if (!sourcePath) {
      return null;
    }
    const kind = element.dataset.stemTargetKind as
      | SemanticTargetKind
      | undefined;
    const path = element.dataset.stemTargetPath;
    const lookupKey = element.dataset.stemTargetKey;
    const occurrence = Number(
      element.dataset.stemTargetOccurrence ?? "1",
    );
    if (kind === PLUGIN_KIND && path && lookupKey) {
      const target = this.index.getTargetByIdentity(
        path,
        kind,
        lookupKey,
        occurrence,
      );
      if (target) {
        return { target, sourcePath };
      }
    }

    if (element.matches("a.internal-link")) {
      const linktext =
        element.getAttribute("data-href") ??
        element.getAttribute("href") ??
        "";
      const target = this.resolveLinktext(linktext, sourcePath);
      return target ? { target, sourcePath } : null;
    }
    if (element.matches(".cm-hmd-internal-link")) {
      const linktext = this.livePreviewLinktext(
        element,
        sourcePath,
      );
      const target = linktext
        ? this.resolveLinktext(linktext, sourcePath)
        : null;
      return target ? { target, sourcePath } : null;
    }
    return null;
  }

  private livePreviewLinktext(
    element: HTMLElement,
    sourcePath: string,
  ): string | null {
    let linktext: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        linktext ||
        !(leaf.view instanceof MarkdownView) ||
        leaf.view.file?.path !== sourcePath ||
        !leaf.view.containerEl.contains(element)
      ) {
        return;
      }
      const editorView = (
        leaf.view.editor as unknown as {
          cm?: EditorView;
        }
      ).cm;
      if (!editorView?.posAtDOM) {
        return;
      }
      try {
        const offset = editorView.posAtDOM(element, 0);
        linktext = findWikiLinkAtOffset(
          editorView.state.doc.toString(),
          offset,
        );
      } catch {
        // An unmappable Live Preview link is left to Obsidian.
      }
    });
    return linktext;
  }

  private writeTargetDataset(
    element: HTMLElement,
    target: IndexedTarget,
  ): void {
    element.dataset.stemTargetPath = target.path;
    element.dataset.stemTargetKind = target.kind;
    element.dataset.stemTargetKey = target.lookupKey;
    element.dataset.stemTargetOccurrence = String(target.occurrence);
  }

  private clearTargetDataset(element: HTMLElement): void {
    delete element.dataset.stemTargetPath;
    delete element.dataset.stemTargetKind;
    delete element.dataset.stemTargetKey;
    delete element.dataset.stemTargetOccurrence;
    delete element.dataset.stemSourcePath;
    element.removeAttribute("role");
    element.removeAttribute("tabindex");
  }

  private clearFormulaReference(formula: HTMLElement): void {
    formula.removeClass("stem-semantic-formula-ref");
    this.clearTargetDataset(formula);
  }

  private clearExplicitLink(link: HTMLElement): void {
    link.removeClass(EXPLICIT_LINK_CLASS);
    link.addClass("is-unresolved");
    this.clearTargetDataset(link);
  }

  private clearAllFormulaReferences(): void {
    document
      .querySelectorAll<HTMLElement>(".stem-semantic-formula-ref")
      .forEach((formula) => {
        this.clearFormulaReference(formula);
      });
  }

  private clearAllEnhancedElements(): void {
    document
      .querySelectorAll<HTMLElement>(`.${EXPLICIT_LINK_CLASS}`)
      .forEach((link) => {
        this.clearExplicitLink(link);
      });
    if (IS_FORMULA_PLUGIN) {
      this.clearAllFormulaReferences();
    }
  }

  private async navigateToTarget(
    target: IndexedTarget,
    sourcePath: string,
    event: MouseEvent | KeyboardEvent,
  ): Promise<void> {
    const newLeaf = Keymap.isModEvent(event) ? "tab" : false;
    const sourceView = this.findOpenMarkdownView(sourcePath);
    if (
      !newLeaf &&
      target.path === sourcePath &&
      sourceView
    ) {
      this.revealTargetInView(sourceView, target);
      return;
    }

    await this.app.workspace.openLinkText(
      target.path,
      sourcePath,
      newLeaf,
      {
        active: true,
        eState: { line: target.lineStart },
      },
    );

    window.requestAnimationFrame(() => {
      const view =
        this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || view.file?.path !== target.path) {
        return;
      }
      this.revealTargetInView(view, target);
    });
  }

  private findOpenMarkdownView(path: string): MarkdownView | null {
    const activeView =
      this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file?.path === path) {
      return activeView;
    }
    let matchingView: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        !matchingView &&
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === path
      ) {
        matchingView = leaf.view;
      }
    });
    return matchingView;
  }

  private revealTargetInView(
    view: MarkdownView,
    target: IndexedTarget,
  ): void {
    view.leaf.setEphemeralState({ line: target.lineStart });
    if (view.getMode() === "source") {
      const position = { line: target.lineStart, ch: 0 };
      view.editor.setCursor(position);
      view.editor.scrollIntoView(
        { from: position, to: position },
        true,
      );
      window.requestAnimationFrame(() => {
        if (view.file?.path === target.path) {
          view.editor.scrollIntoView(
            { from: position, to: position },
            true,
          );
        }
      });
      return;
    }
    const lineElements = Array.from(
      view.previewMode.containerEl.querySelectorAll<HTMLElement>(
        "[data-line]",
      ),
    );
    const closest = lineElements
      .map((element) => ({
        element,
        line: Number(element.dataset.line),
      }))
      .filter(
        (candidate) =>
          Number.isFinite(candidate.line) &&
          candidate.line <= target.lineStart,
      )
      .sort((left, right) => right.line - left.line)[0];
    closest?.element.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }

  private schedulePopover(
    anchor: HTMLElement,
    reference: ResolvedReference,
  ): void {
    if (this.hoverAnchor === anchor && this.popoverEl) {
      return;
    }
    if (this.hoverOpenTimer !== null) {
      window.clearTimeout(this.hoverOpenTimer);
    }
    this.hoverOpenTimer = window.setTimeout(() => {
      this.hoverOpenTimer = null;
      void this.openPopover(anchor, reference);
    }, this.settings.hoverDelayMs);
  }

  private async openPopover(
    anchor: HTMLElement,
    reference: ResolvedReference,
  ): Promise<void> {
    this.closePopover();
    if (!anchor.isConnected) {
      return;
    }
    this.hoverAnchor = anchor;
    const doc = anchor.ownerDocument;
    const popover = doc.body.createDiv("stem-semantic-popover");
    this.popoverEl = popover;
    if (reference.target.kind === "formula") {
      popover.createDiv({
        cls: "stem-semantic-popover__meta",
        text: `${reference.target.file.basename} › (${reference.target.label})`,
      });
    }
    const body = popover.createDiv("stem-semantic-popover__body");
    body.addClass("markdown-rendered");
    const component = new Component();
    component.load();
    this.popoverComponent = component;

    popover.addEventListener("mouseenter", () => {
      this.cancelHoverClose();
    });
    popover.addEventListener("mouseleave", () => {
      this.schedulePopoverClose();
    });

    this.positionPopover(anchor, popover);
    await MarkdownRenderer.render(
      this.app,
      limitMarkdownLines(
        reference.target.markdown,
        this.settings.previewMaxLines,
      ),
      body,
      reference.target.path,
      component,
    );
    this.enhanceElementTree(body, reference.target.path);
    this.positionPopover(anchor, popover);
  }

  private positionPopover(
    anchor: HTMLElement,
    popover: HTMLElement,
  ): void {
    const win = anchor.ownerDocument.defaultView ?? window;
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const width = popover.offsetWidth || Math.min(560, win.innerWidth - 24);
    const height = popover.offsetHeight || 240;
    let left = Math.min(
      Math.max(margin, rect.left),
      win.innerWidth - width - margin,
    );
    let top = rect.bottom + 8;
    if (top + height > win.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - 8);
    }
    if (!Number.isFinite(left)) {
      left = margin;
    }
    popover.setCssStyles({
      left: `${left}px`,
      top: `${top}px`,
    });
  }

  private schedulePopoverClose(): void {
    if (this.hoverCloseTimer !== null) {
      window.clearTimeout(this.hoverCloseTimer);
    }
    this.hoverCloseTimer = window.setTimeout(() => {
      this.hoverCloseTimer = null;
      this.closePopover();
    }, 160);
  }

  private cancelHoverClose(): void {
    if (this.hoverCloseTimer !== null) {
      window.clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
  }

  private closePopover(): void {
    if (this.hoverOpenTimer !== null) {
      window.clearTimeout(this.hoverOpenTimer);
      this.hoverOpenTimer = null;
    }
    this.cancelHoverClose();
    this.popoverComponent?.unload();
    this.popoverComponent = null;
    this.popoverEl?.remove();
    this.popoverEl = null;
    this.hoverAnchor = null;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

function collectMatches<T extends Element>(
  root: Element,
  selector: string,
): T[] {
  const matches: T[] = [];
  if (root.matches(selector)) {
    matches.push(root as T);
  }
  matches.push(...Array.from(root.querySelectorAll<T>(selector)));
  return matches;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function filterTargets(
  candidates: IndexedTarget[],
  query: string,
  limit: number,
): IndexedTarget[] {
  const terms = query
    .normalize("NFC")
    .toLocaleLowerCase()
    .trim()
    .replace(/^\(|\)$/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) {
    return candidates.slice(0, limit);
  }

  return candidates
    .map((target, order) => {
      const label = target.label.toLocaleLowerCase();
      const referenceLabel =
        targetReferenceLabel(target).toLocaleLowerCase();
      const basename = target.file.basename.toLocaleLowerCase();
      const path = target.path.toLocaleLowerCase();
      const searchable =
        `${referenceLabel}\n${label}\n${basename}\n${path}`;
      if (!terms.every((term) => searchable.includes(term))) {
        return null;
      }
      let score = 0;
      for (const term of terms) {
        if (referenceLabel === term || label === term) {
          score += 100;
        } else if (
          referenceLabel.startsWith(term) ||
          label.startsWith(term)
        ) {
          score += 70;
        } else if (
          referenceLabel.includes(term) ||
          label.includes(term)
        ) {
          score += 50;
        } else if (basename.includes(term)) {
          score += 25;
        } else {
          score += 10;
        }
      }
      return { target, order, score };
    })
    .filter(
      (
        match,
      ): match is {
        target: IndexedTarget;
        order: number;
        score: number;
      } => match !== null,
    )
    .sort(
      (left, right) =>
        right.score - left.score || left.order - right.order,
    )
    .slice(0, limit)
    .map((match) => match.target);
}

function renderTargetSuggestion(
  target: IndexedTarget,
  el: HTMLElement,
): void {
  el.addClass("stem-semantic-suggestion");
  if (target.kind === "formula") {
    const formula = el.createDiv({
      cls: "stem-semantic-suggestion__formula",
    });
    const latex = stripFormulaTag(target.markdown)
      .replace(/^\s*\$\$\s*/, "")
      .replace(/\s*\$\$\s*$/, "")
      .trim();
    formula.appendChild(
      renderMath(latex, true),
    );
    scheduleSuggestionMathFlush();
    el.createDiv({
      cls: "stem-semantic-suggestion__path",
      text: `(${target.label}) · ${target.path} · 第 ${target.lineStart + 1} 行`,
    });
    return;
  }
  el.createDiv({
    cls: "stem-semantic-suggestion__label",
    text: targetReferenceLabel(target),
  });
  el.createDiv({
    cls: "stem-semantic-suggestion__path",
    text: `${target.path} · 第 ${target.lineStart + 1} 行`,
  });
}

function scheduleSuggestionMathFlush(): void {
  if (suggestionMathFlushScheduled) {
    return;
  }
  suggestionMathFlushScheduled = true;
  queueMicrotask(() => {
    suggestionMathFlushScheduled = false;
    void finishRenderMath();
  });
}

function targetReferenceLabel(target: ParsedSemanticTarget): string {
  if (target.kind === "formula") {
    return `(${target.label})`;
  }
  return target.occurrence > 1
    ? `${target.label} ${target.occurrence - 1}`
    : target.label;
}

function limitMarkdownLines(markdown: string, maxLines: number): string {
  const lines = markdown.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return markdown;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n\n…`;
}

function escapeWikiAlias(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function unescapeWikiAlias(value: string): string {
  return value.replace(/\\\|/g, "|");
}

function semanticTargetIdentity(
  kind: SemanticTargetKind,
  lookupKey: string,
  occurrence: number,
): string {
  return `${kind}\u0000${lookupKey}\u0000${occurrence}`;
}

async function enqueueGlobalReferenceSync(
  task: () => Promise<void>,
): Promise<void> {
  const host = window as typeof window & {
    __stemSemanticReferenceSyncQueue?: Promise<void>;
  };
  const previous =
    host.__stemSemanticReferenceSyncQueue ?? Promise.resolve();
  const current = previous.then(task, task);
  host.__stemSemanticReferenceSyncQueue = current.catch((error) => {
    console.error("[STEM 语义引用] 自动同步失败", error);
  });
  await current;
}
