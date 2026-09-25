import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test';
import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { startFakeBackendServers } from './support/fake-backends.mjs';
import { createFakeMavenHome } from './support/fake-maven.mjs';

const WORKSTATION_ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURE_ROOT = join(WORKSTATION_ROOT, 'fixtures', 'multi-class-generation');
const CLASS_NAMES = [
  'AlphaService',
  'BetaService',
  'GammaService',
  'DeltaService',
  'EpsilonService'
];

type ElectronFixture = {
  app: ElectronApplication;
  page: Page;
  workspaceRoot: string;
  userDataRoot: string;
  sourceFilePaths: string[];
  backends: Awaited<ReturnType<typeof startFakeBackendServers>>;
  toolchain: Awaited<ReturnType<typeof createFakeMavenHome>>;
  restart(): Promise<Page>;
  close(): Promise<void>;
};

test('resizing the right task panel keeps Monaco content and scrollbars inside the editor column', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await page.locator('.class-task-card-action.locate').click();
    await expect(page.locator('.local-monaco-editor-host .monaco-editor')).toBeVisible();

    const rightResizeHandle = page.locator('.resize-handle').nth(1);
    const before = await readResizableEditorGeometry(page);
    const handleBox = await rightResizeHandle.boundingBox();
    expect(handleBox).not.toBeNull();

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 120);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x - 160, handleBox!.y + 120);

    const duringResize = await readResizableEditorGeometry(page);
    expect(duringResize.editorWidth).toBeLessThan(before.editorWidth - 100);
    expect(duringResize.agentWidth).toBeGreaterThan(before.agentWidth + 100);
    expect(duringResize.hostRight).toBeLessThanOrEqual(duringResize.handleLeft + 1);
    expect(duringResize.monacoRight).toBeLessThanOrEqual(duringResize.hostRight + 1);
    expect(duringResize.minimapRight).toBeLessThanOrEqual(duringResize.hostRight + 1);
    expect(duringResize.verticalScrollbarRight).toBeLessThanOrEqual(duringResize.hostRight + 1);

    await page.mouse.up();
  } finally {
    await fixture.close();
  }
});

test('class tasks are added through drag or blank-area paste without a file picker', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    const dropzone = page.locator('.class-task-dropzone');
    await expect(dropzone.locator('input[type="file"]')).toHaveCount(0, { timeout: 1_000 });
    await expect(dropzone).not.toHaveAttribute('role', 'button');
    await expect(dropzone).toContainText('拖拽或粘贴文件到下方');
    await expect(dropzone).not.toContainText('点击添加');
    await expect(dropzone.getByRole('button', { name: '粘贴已复制的类' })).toHaveCount(0);

    const fileChooserState = page.waitForEvent('filechooser', { timeout: 300 })
      .then(() => 'opened', () => 'not-opened');
    await dropzone.click({ position: { x: 4, y: 4 } });
    expect(await fileChooserState).toBe('not-opened');

    await addFiveClassTasks(fixture);
    await expect(page.locator('.class-task-card')).toHaveCount(5);
    await expect(page.locator('.class-task-card.focused')).toHaveCount(0);
    await expect(page.locator('.class-task-card').first()).toHaveCSS(
      'border-top-color',
      'rgba(0, 0, 0, 0)'
    );
  } finally {
    await fixture.close();
  }
});

test('Explorer Ctrl and Shift selections can be copied and pasted into the blank task area', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '定位源码' }).click();
    const alphaClass = page.locator('.file-node').filter({ hasText: 'AlphaService.java' });
    const betaClass = page.locator('.file-node').filter({ hasText: 'BetaService.java' });
    const deltaClass = page.locator('.file-node').filter({ hasText: 'DeltaService.java' });
    const epsilonClass = page.locator('.file-node').filter({ hasText: 'EpsilonService.java' });
    await alphaClass.click();
    await page.keyboard.down('Control');
    await betaClass.click();
    await page.keyboard.up('Control');
    await expect(alphaClass).toHaveClass(/\bselected\b/);
    await expect(betaClass).toHaveClass(/\bselected\b/);

    await page.keyboard.down('Shift');
    await epsilonClass.click();
    await page.keyboard.up('Shift');
    await expect(alphaClass).not.toHaveClass(/\bselected\b/);
    await expect(betaClass).toHaveClass(/\bselected\b/);
    await expect(deltaClass).toHaveClass(/\bselected\b/);
    await expect(epsilonClass).toHaveClass(/\bselected\b/);
    await expect(epsilonClass).toHaveCSS('outline-style', 'none');

    const draggedPaths = await epsilonClass.evaluate((element) => {
      const transfer = new DataTransfer();
      element.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        dataTransfer: transfer
      }));
      return transfer.getData('text/plain');
    });
    expect(draggedPaths.split(/\r?\n/).filter(Boolean)).toEqual([
      fixture.sourceFilePaths[1],
      fixture.sourceFilePaths[3],
      fixture.sourceFilePaths[4]
    ]);

    await page.waitForTimeout(500);
    await expect(epsilonClass).toBeFocused();
    // 复制应先直接写入系统剪贴板，不能依赖可能尚未随开发热更新重载的主进程 IPC。
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler('clipboard:write-text'));
    await page.keyboard.press('Control+C');
    await expect.poll(async () => (
      await app.evaluate(({ clipboard }) => clipboard.readText())
    ).split(/\r?\n/).filter(Boolean)).toEqual([
      fixture.sourceFilePaths[1],
      fixture.sourceFilePaths[3],
      fixture.sourceFilePaths[4]
    ]);

    await card.getByRole('button', { name: '删除当前任务' }).click();
    await expect(page.locator('.class-task-card')).toHaveCount(0);
    const blankTaskArea = page.locator('.class-task-card-list');
    await blankTaskArea.click({ position: { x: 20, y: 120 } });
    await expect(blankTaskArea).toBeFocused();
    await page.keyboard.press('Control+V');
    await expect(page.locator('.class-task-card')).toHaveCount(3, { timeout: 5_000 });
    await expect(page.locator('.class-task-card-name')).toHaveText([
      'BetaService.java',
      'DeltaService.java',
      'EpsilonService.java'
    ]);
  } finally {
    await fixture.close();
  }
});

test('pasting more classes than the remaining capacity keeps the first five and shows the limit', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 2), '.class-task-card-list');
    await expect(page.locator('.class-task-card')).toHaveCount(2);
    const overflowPath = join(fixture.workspaceRoot, 'OverflowService.java');
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      [...fixture.sourceFilePaths.slice(2), overflowPath].join('\r\n')
    );

    const blankTaskArea = page.locator('.class-task-card-list');
    const blankTaskAreaBox = await blankTaskArea.boundingBox();
    expect(blankTaskAreaBox).not.toBeNull();
    await blankTaskArea.click({
      position: { x: 20, y: Math.max(20, blankTaskAreaBox!.height - 20) }
    });
    await page.keyboard.press('Control+V');

    const cards = page.locator('.class-task-card');
    await expect(cards).toHaveCount(5, { timeout: 5_000 });
    await expect(cards.locator('.class-task-card-name')).toHaveText([
      'AlphaService.java',
      'BetaService.java',
      'GammaService.java',
      'DeltaService.java',
      'EpsilonService.java'
    ]);
    const capacityWarning = page.locator('.class-task-capacity-warning');
    await expect(capacityWarning).toHaveText('最多添加5个');
    const warningLayout = await capacityWarning.evaluate((element) => {
      const cardList = element.parentElement;
      const previous = element.previousElementSibling;
      if (!cardList || !previous) throw new Error('capacity warning must follow the last card');
      return {
        isInsideCardList: cardList.classList.contains('class-task-card-list'),
        isLastChild: cardList.lastElementChild === element,
        previousIsCard: previous.classList.contains('class-task-card'),
        warningTop: element.getBoundingClientRect().top,
        previousBottom: previous.getBoundingClientRect().bottom
      };
    });
    expect(warningLayout).toMatchObject({
      isInsideCardList: true,
      isLastChild: true,
      previousIsCard: true
    });
    expect(warningLayout.warningTop).toBeGreaterThanOrEqual(warningLayout.previousBottom);

    await page.locator('.class-task-panel-header').click({ position: { x: 200, y: 20 } });
    await expect(capacityWarning).toHaveCount(0);

    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      overflowPath
    );
    const fullTaskAreaBox = await blankTaskArea.boundingBox();
    expect(fullTaskAreaBox).not.toBeNull();
    await blankTaskArea.click({
      position: { x: 20, y: Math.max(20, fullTaskAreaBox!.height - 20) }
    });
    await page.keyboard.press('Control+V');
    await expect(capacityWarning).toHaveText('最多添加5个');
    await expect(capacityWarning).toHaveCount(0, { timeout: 4_500 });
    await waitForTaskStates(page, fixture.workspaceRoot, Array(5).fill('READY'));
  } finally {
    await fixture.close();
  }
});

test('dropping more classes than the remaining capacity keeps the first five and shows the limit', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 2), '.class-task-card-list');
    await expect(page.locator('.class-task-card')).toHaveCount(2);
    const overflowPath = join(fixture.workspaceRoot, 'OverflowService.java');
    await cp(fixture.sourceFilePaths[4], overflowPath);

    await dropClassTasks(
      fixture,
      [...fixture.sourceFilePaths.slice(2), overflowPath],
      '.class-task-card-list'
    );

    const cards = page.locator('.class-task-card');
    await expect(cards).toHaveCount(5, { timeout: 5_000 });
    await expect(cards.locator('.class-task-card-name')).toHaveText([
      'AlphaService.java',
      'BetaService.java',
      'GammaService.java',
      'DeltaService.java',
      'EpsilonService.java'
    ]);
    await expect(page.locator('.class-task-capacity-warning')).toHaveText('最多添加5个');
  } finally {
    await fixture.close();
  }
});

test('the right task area accepts drops outside the prompt box', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    await dropClassTasks(
      fixture,
      fixture.sourceFilePaths.slice(0, 2),
      '.class-task-card-list'
    );
    await expect(fixture.page.locator('.class-task-card')).toHaveCount(2, { timeout: 5_000 });
  } finally {
    await fixture.close();
  }
});

test('the prompt shows the current class task capacity', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const dropzone = fixture.page.locator('.class-task-dropzone');
    const prompt = dropzone.locator('.class-task-dropzone-prompt');
    const capacity = dropzone.locator('.class-task-capacity');
    await expect(prompt).toContainText('拖拽或粘贴文件到下方', { timeout: 1_000 });
    await expect(dropzone).not.toContainText('最多添加 5 个类，可同时执行');
    await expect(capacity).toHaveText('0/5', { timeout: 1_000 });

    const [dropzoneBox, promptBox] = await Promise.all([
      dropzone.boundingBox(),
      prompt.boundingBox()
    ]);
    expect(dropzoneBox).not.toBeNull();
    expect(promptBox).not.toBeNull();
    expect(Math.abs(
      (dropzoneBox!.x + dropzoneBox!.width / 2)
      - (promptBox!.x + promptBox!.width / 2)
    )).toBeLessThanOrEqual(1);
    expect(dropzoneBox!.height).toBeLessThanOrEqual(44);

    await dropClassTasks(
      fixture,
      fixture.sourceFilePaths.slice(0, 2),
      '.class-task-dropzone'
    );
    await expect(capacity).toHaveText('2/5');
  } finally {
    await fixture.close();
  }
});

test('approved compact card hierarchy is preserved', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await addFiveClassTasks(fixture);
    await waitForTaskStates(page, fixture.workspaceRoot, Array(5).fill('READY'));

    const card = page.locator('.class-task-card').first();
    await expect(card.locator('.class-task-card-name')).toHaveText('AlphaService.java');
    const statusDot = card.locator('.class-task-card-status-dot');
    await expect(statusDot).toBeVisible();
    await expect(statusDot).toHaveClass(/\bneutral\b/);
    await expect(statusDot).toHaveCSS('background-color', 'rgb(130, 144, 156)');
    await expect(card.locator('.class-task-status')).toHaveText('待执行');

    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.height).toBeLessThanOrEqual(68);

    const controls = card.locator('.class-task-card-action, .class-task-card-spinner-slot');
    for (let index = 0; index < await controls.count(); index += 1) {
      const controlBox = await controls.nth(index).boundingBox();
      expect(controlBox).not.toBeNull();
      expect(controlBox!.width).toBe(31);
      expect(controlBox!.height).toBe(31);
      expect(Math.abs(
        (controlBox!.y + controlBox!.height / 2)
        - (cardBox!.y + cardBox!.height / 2)
      )).toBeLessThanOrEqual(1);
    }

    expect(await page.locator('.class-task-panel-hint').evaluate(
      (node) => getComputedStyle(node).fontSize
    )).toBe('11px');
  } finally {
    await fixture.close();
  }
});

test('method progress stays below the class name in the left content column', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    const baseUpdatedAt = Date.parse(task.updatedAt);
    const running = {
      ...task,
      state: 'RUNNING',
      methodOrder: ['method-1', 'method-2', 'method-3'],
      currentMethodIndex: 0,
      currentAtomicStep: 'MODEL_GENERATION',
      generatedArtifacts: [{ ordinaryTestMethodCount: 2 }],
      startedAt: new Date(baseUpdatedAt).toISOString(),
      finishedAt: null,
      updatedAt: new Date(baseUpdatedAt + 1_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, running);

    const card = page.locator('.class-task-card').first();
    const main = card.locator('.class-task-card-main');
    const heading = card.locator('.class-task-card-heading');
    const meta = card.locator('.class-task-card-meta');
    const progress = card.locator('.class-task-card-progress');
    const progressbar = progress.getByRole('progressbar', {
      name: '已完成 1/3 个方法；当前方法处理中'
    });
    const progressCount = progress.locator('.class-task-card-progress-count');
    const track = progress.locator('.class-task-card-progress-track');
    const fill = progress.locator('.class-task-card-progress-fill');
    const actions = card.locator('.class-task-card-actions');
    const summary = card.locator('.class-task-card-summary');
    const testSummary = summary.locator('.class-task-card-test-summary');
    const status = card.locator('.class-task-status');

    await expect(progress).toBeVisible();
    await expect(progress).toHaveClass(/\bactive\b/);
    await expect(progressCount).toHaveText('完成 1/3');
    await expect(progress).not.toContainText('已生成');
    await expect(progress).not.toContainText('个方法');
    await expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    await expect(progressbar).toHaveAttribute('aria-valuenow', '1');
    await expect(progressbar).toHaveAttribute('aria-valuemax', '3');
    await expect(track).toHaveCSS('background-color', 'rgb(75, 86, 96)');
    await expect(fill).toHaveCSS('background-color', 'rgb(77, 170, 252)');
    await expect(fill).toHaveCSS('animation-name', 'class-task-card-completed-wave');
    await expect(fill).toHaveCSS('animation-iteration-count', 'infinite');
    await expect(progressCount).toHaveCSS('color', 'rgb(77, 170, 252)');
    await expect(summary).toBeVisible();
    await expect(testSummary).toHaveText('1 个文件 · 2 个测试');
    await expect(card.locator('.class-task-card-meta')).not.toContainText('个文件');

    const [cardBox, mainBox, headingBox, metaBox, progressBox, trackBox, fillBox, countBox, actionsBox, summaryBox, testSummaryBox, statusBox] = await Promise.all([
      card.boundingBox(),
      main.boundingBox(),
      heading.boundingBox(),
      meta.boundingBox(),
      progress.boundingBox(),
      track.boundingBox(),
      fill.boundingBox(),
      progressCount.boundingBox(),
      actions.boundingBox(),
      summary.boundingBox(),
      testSummary.boundingBox(),
      status.boundingBox()
    ]);
    expect(cardBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(metaBox).not.toBeNull();
    expect(progressBox).not.toBeNull();
    expect(trackBox).not.toBeNull();
    expect(fillBox).not.toBeNull();
    expect(countBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    expect(testSummaryBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(Math.abs(progressBox!.x - mainBox!.x)).toBeLessThanOrEqual(1);
    expect(progressBox!.x + progressBox!.width)
      .toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 1);
    expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(progressBox!.y + 1);
    expect(progressBox!.y + progressBox!.height).toBeLessThanOrEqual(metaBox!.y + 1);
    expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(actionsBox!.x + 1);
    expect(summaryBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height - 1);
    expect(Math.abs(testSummaryBox!.x - statusBox!.x)).toBeLessThanOrEqual(1);
    expect(summaryBox!.x).toBeLessThanOrEqual(mainBox!.x + 1);
    expect(summaryBox!.x + summaryBox!.width).toBeGreaterThanOrEqual(actionsBox!.x + actionsBox!.width - 1);
    expect(trackBox!.x + trackBox!.width).toBeLessThanOrEqual(countBox!.x + 1);
    expect(fillBox!.width / trackBox!.width).toBeGreaterThan(0.3);
    expect(fillBox!.width / trackBox!.width).toBeLessThan(0.36);

    const paused = {
      ...running,
      state: 'PAUSED',
      updatedAt: new Date(baseUpdatedAt + 2_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, paused);
    await expect(progress).toHaveClass(/\bpaused\b/);
    await expect(progressCount).toHaveText('完成 1/3');
    await expect(progress).not.toContainText('已生成');
    await expect(progress).not.toContainText('个方法');
    await expect(fill).toHaveCSS('background-color', 'rgb(211, 168, 78)');
    await expect(fill).toHaveCSS('animation-name', 'none');
    await expect(progressCount).toHaveCSS('color', 'rgb(211, 168, 78)');

    const stopping = {
      ...paused,
      state: 'STOPPING',
      updatedAt: new Date(baseUpdatedAt + 3_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, stopping);
    await expect(progress).toHaveCount(0);
    await expect(summary.locator('.class-task-card-progress-label')).toHaveText('已完成 1/3 个方法');
    await expect(summary).toContainText('1 个文件 · 2 个测试');
    await expect(summary.locator('.class-task-card-summary-separator')).toHaveCount(1);

    const terminated = {
      ...stopping,
      state: 'TERMINATED',
      finishedAt: new Date(baseUpdatedAt + 4_000).toISOString(),
      updatedAt: new Date(baseUpdatedAt + 4_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, terminated);
    await expect(progress).toHaveCount(0);
    await expect(summary.locator('.class-task-card-progress-label')).toHaveText('已完成 1/3 个方法');
    await expect(card.locator('.class-task-card-elapsed'))
      .toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 1)');
    const [terminatedMainBox, terminatedSummaryBox] = await Promise.all([
      main.boundingBox(),
      summary.boundingBox()
    ]);
    expect(terminatedMainBox).not.toBeNull();
    expect(terminatedSummaryBox).not.toBeNull();
    expect(terminatedSummaryBox!.y)
      .toBeGreaterThanOrEqual(terminatedMainBox!.y + terminatedMainBox!.height - 1);
  } finally {
    await fixture.close();
  }
});

test('class task error details keep long Maven output behind a subtle compact scrollbar', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    const failed = {
      ...task,
      state: 'PRELOAD_FAILED',
      preloadState: 'FAILED',
      lastError: {
        code: 'CLASS_PRELOAD_MAVEN_FAILED',
        message: Array.from(
          { length: 180 },
          (_, index) => `[ERROR] 第 ${index + 1} 行：${'com.example.GeneratedTest,'.repeat(3)}`
        ).join('\n'),
        moduleName: task.qualifiedClassName,
        modulePath: task.moduleDisplayPath,
        command: `mvn -Dtest=${'com.example.GeneratedTest,'.repeat(30)} test`,
        occurredAt: new Date(Date.parse(task.updatedAt) + 1_000).toISOString()
      },
      updatedAt: new Date(Date.parse(task.updatedAt) + 1_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, failed);

    const card = page.locator('.class-task-card').first();
    const anchor = card.locator('.class-task-card-error-anchor');
    const popover = page.locator('.class-task-card-error-popover');
    const panel = page.locator('.class-task-panel');
    await expect(anchor).toHaveText(/查看详情/);
    await expect(anchor).not.toHaveAttribute('title');
    await expect(anchor).toHaveCSS('cursor', 'pointer');
    await anchor.hover();
    await expect(popover).toBeVisible();

    const popoverScroll = await popover.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      viewportHeight: window.innerHeight
    }));
    expect(popoverScroll.clientHeight).toBeLessThanOrEqual(popoverScroll.viewportHeight * .68 + 2);
    expect(popoverScroll.scrollHeight).toBeGreaterThan(popoverScroll.clientHeight);
    expect(popoverScroll.overflowY).toBe('auto');

    const scrollbarVisuals = await popover.evaluate((element) => {
      const alphaOf = (color: string): number => {
        if (color === 'transparent') return 0;
        const components = color.match(/[\d.]+/g)?.map(Number) ?? [];
        return components.length >= 4 ? components[3] : components.length === 3 ? 1 : 0;
      };
      const scrollbarStyle = getComputedStyle(element, '::-webkit-scrollbar');
      const trackStyle = getComputedStyle(element, '::-webkit-scrollbar-track');
      const thumbStyle = getComputedStyle(element, '::-webkit-scrollbar-thumb');
      return {
        width: Number.parseFloat(scrollbarStyle.width),
        trackAlpha: alphaOf(trackStyle.backgroundColor),
        thumbAlpha: alphaOf(thumbStyle.backgroundColor)
      };
    });
    expect(scrollbarVisuals.width).toBeLessThanOrEqual(4);
    expect(scrollbarVisuals.trackAlpha).toBe(0);
    expect(scrollbarVisuals.thumbAlpha).toBeGreaterThan(0);
    expect(scrollbarVisuals.thumbAlpha).toBeLessThanOrEqual(.35);

    const [anchorBox, popoverBox, paragraphBox, panelBox] = await Promise.all([
      anchor.boundingBox(),
      popover.boundingBox(),
      popover.locator('p').boundingBox(),
      panel.boundingBox()
    ]);
    expect(anchorBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(paragraphBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(popoverBox!.x).toBeLessThan(anchorBox!.x);
    expect(Math.abs(
      popoverBox!.x + popoverBox!.width - (anchorBox!.x + anchorBox!.width)
    )).toBeLessThanOrEqual(1);
    expect(paragraphBox!.x + paragraphBox!.width)
      .toBeLessThanOrEqual(popoverBox!.x + popoverBox!.width);
    expect(popoverBox!.x).toBeLessThan(panelBox!.x - 8);

    const visiblePopoverLeft = Math.max(1, popoverBox!.x);
    const panelLeft = Math.min(panelBox!.x, popoverBox!.x + popoverBox!.width);
    const popoverOwnsPointLeftOfPanel = await page.evaluate(({ x, y }) => (
      document.elementFromPoint(x, y)?.closest('.class-task-card-error-popover') !== null
    ), {
      x: visiblePopoverLeft + Math.min(8, (panelLeft - visiblePopoverLeft) / 2),
      y: popoverBox!.y + 12
    });
    expect(popoverOwnsPointLeftOfPanel).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('a ready class with no selected methods prompts instead of starting execution', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '执行当前类' }).click();

    await expect(card.locator('.class-task-card-selection-hint'))
      .toHaveText('请先选择至少一个方法');
    await expect.poll(async () => (await listTasks(page, fixture.workspaceRoot))[0]?.state)
      .toBe('READY');
    expect(fixture.backends.metrics().realModelCalls).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('opening method configuration does not overwrite a newer PRELOADING snapshot', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    const catalog = await page.evaluate(async ({ workspaceRoot, taskId }) => (
      (window as any).workstation.getClassTaskMethods({ workspaceRoot, taskId })
    ), { workspaceRoot: fixture.workspaceRoot, taskId: task.id });

    await app.evaluate(({ ipcMain }, delayedCatalog) => {
      const state = globalThis as typeof globalThis & {
        __e2eClassTaskMethodsRequested?: boolean;
        __e2eResolveClassTaskMethods?: () => void;
      };
      ipcMain.removeHandler('class-task:methods:get');
      state.__e2eClassTaskMethodsRequested = false;
      ipcMain.handle('class-task:methods:get', async () => {
        state.__e2eClassTaskMethodsRequested = true;
        return new Promise((resolve) => {
          state.__e2eResolveClassTaskMethods = () => resolve(delayedCatalog);
        });
      });
    }, catalog);

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '配置生成方法' }).click();
    await expect.poll(() => app.evaluate(() => Boolean(
      (globalThis as typeof globalThis & { __e2eClassTaskMethodsRequested?: boolean })
        .__e2eClassTaskMethodsRequested
    ))).toBe(true);

    const methodTab = page.locator('.editor-tab', {
      hasText: `${task.qualifiedClassName.split('.').pop()} · 方法`
    });
    await expect(methodTab).toBeVisible();
    await expect(methodTab).toHaveClass(/\bactive\b/);

    const loading = page.locator('.class-task-method-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toContainText('正在读取覆盖率信息');
    await expect(loading).toContainText(task.qualifiedClassName);
    await expect(page.locator('.class-task-method-page')).toHaveCount(0);

    const preloading = {
      ...task,
      state: 'PRELOADING',
      preloadState: 'RUNNING',
      updatedAt: new Date(Date.parse(task.updatedAt) + 1_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'class-task:snapshot-changed',
        snapshot
      );
    }, preloading);
    await expect(card.locator('.class-task-status')).toHaveText('正在预加载');

    await app.evaluate(() => {
      const resolveMethods = (
        globalThis as typeof globalThis & { __e2eResolveClassTaskMethods?: () => void }
      ).__e2eResolveClassTaskMethods;
      if (!resolveMethods) throw new Error('Delayed class-task methods request was not captured');
      resolveMethods();
    });

    const methodPage = page.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(card.locator('.class-task-status')).toHaveText('正在预加载');
    await expect(methodPage.locator('.class-task-method-save')).toBeDisabled();
  } finally {
    await fixture.close();
  }
});

test('method configuration tab context menu can close all workbench tabs', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '定位源码' }).click();
    await card.getByRole('button', { name: '配置生成方法' }).click();

    const tabs = page.locator('.editor-tab-list .editor-tab');
    await expect(tabs).toHaveCount(2);
    const methodTab = tabs.filter({ hasText: '· 方法' });
    await methodTab.click({ button: 'right' });

    const contextMenu = page.locator('.tab-context-menu');
    await expect(contextMenu).toBeVisible();
    await expect(contextMenu.getByRole('button', { name: '关闭所有标签页' })).toBeVisible();
    await contextMenu.getByRole('button', { name: '关闭所有标签页' }).click();

    await expect(page.locator('.editor-tab-list')).toHaveCount(0);
    await expect(page.locator('.editor-tab.placeholder')).toHaveText('未打开文件');
  } finally {
    await fixture.close();
  }
});

test('failed method catalog loading can be retried from the configuration page', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    const catalog = await page.evaluate(async ({ workspaceRoot, taskId }) => (
      (window as any).workstation.getClassTaskMethods({ workspaceRoot, taskId })
    ), { workspaceRoot: fixture.workspaceRoot, taskId: task.id });

    await app.evaluate(({ ipcMain }, successfulCatalog) => {
      const state = globalThis as typeof globalThis & {
        __e2eClassTaskMethodLoadAttempts?: number;
      };
      ipcMain.removeHandler('class-task:methods:get');
      state.__e2eClassTaskMethodLoadAttempts = 0;
      ipcMain.handle('class-task:methods:get', async () => {
        state.__e2eClassTaskMethodLoadAttempts =
          (state.__e2eClassTaskMethodLoadAttempts ?? 0) + 1;
        if (state.__e2eClassTaskMethodLoadAttempts === 1) {
          throw new Error('fixture coverage unavailable');
        }
        return successfulCatalog;
      });
    }, catalog);

    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '配置生成方法' })
      .click();

    const loadError = page.locator('.class-task-method-load-error');
    await expect(loadError).toBeVisible();
    await expect(loadError).toContainText('覆盖率信息读取失败');
    await expect(loadError).not.toContainText('fixture coverage unavailable');
    const retry = loadError.getByRole('button', { name: '重试加载覆盖率信息' });
    await expect(retry).toHaveText('重试');

    await retry.click();

    await expect(page.locator('.class-task-method-page')).toBeVisible();
    await expect(loadError).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => (
      (globalThis as typeof globalThis & { __e2eClassTaskMethodLoadAttempts?: number })
        .__e2eClassTaskMethodLoadAttempts ?? 0
    ))).toBe(2);
  } finally {
    await fixture.close();
  }
});

test('manual method refresh applies the latest prepared coverage and preserves the unsaved configuration', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];

    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '配置生成方法' })
      .click();
    const methodPage = page.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();
    const totalRow = methodPage.getByRole('row', { name: 'JaCoCo 报告总计' });
    await expect(totalRow).toBeVisible();
    await expect(totalRow.locator('td')).toHaveCount(10);
    await expect(totalRow.locator('td').nth(1)).toHaveText('总计');
    await expect(totalRow.locator('td').nth(2)).toHaveText('4 of 8');
    await expect(totalRow.locator('td').nth(3)).toHaveText('50%');
    await expect(totalRow.locator('td').nth(4)).toHaveText('2 of 2');
    await expect(totalRow.locator('td').nth(5)).toHaveText('0%');
    await expect(totalRow.locator('td').nth(6)).toHaveText('1');
    await expect(totalRow.locator('td').nth(7)).toHaveText('2');
    await expect(totalRow.locator('td').nth(8)).toHaveText('1');
    await expect(totalRow.locator('td').nth(9)).toHaveText('2');
    await expect(totalRow.locator('.class-task-method-coverage-bar')).toHaveCount(0);
    await expect(
      methodPage.locator('tbody .class-task-method-row').first()
        .locator('.class-task-method-coverage-bar')
    ).toHaveCount(2);

    const selectedMethod = methodPage.locator('.class-task-method-checkbox').first();
    await selectedMethod.click();
    await expect(selectedMethod).toHaveAttribute('aria-checked', 'true');
    const repairLimit = methodPage.getByRole('spinbutton', { name: '修复轮次' });
    await repairLimit.fill('7');

    const currentCatalog = await page.evaluate(async ({ workspaceRoot, taskId }) => (
      (window as any).workstation.getClassTaskMethods({ workspaceRoot, taskId })
    ), { workspaceRoot: fixture.workspaceRoot, taskId: task.id });
    const refreshedCatalog = {
      ...currentCatalog,
      refreshedAt: new Date(Date.parse(currentCatalog.refreshedAt) + 1_000).toISOString(),
      reportCoverageTotals: {
        ...currentCatalog.reportCoverageTotals,
        instructionCovered: 46,
        instructionMissed: 4_313,
        branchCovered: 2,
        branchMissed: 617
      },
      methods: currentCatalog.methods.map((method: any, index: number) => index === 0
        ? {
            ...method,
            lineCovered: method.lineCovered + method.lineMissed,
            lineMissed: 0,
            instructionCovered: method.instructionCovered + method.instructionMissed,
            instructionMissed: 0,
            coverageGap: false
          }
        : method)
    };

    await app.evaluate(({ ipcMain }, latestCatalog) => {
      const state = globalThis as typeof globalThis & {
        __e2eManualMethodRefresh?: {
          checkAttempts: number;
          getAttempts: number;
          request: unknown;
          resolve?: () => void;
        };
      };
      ipcMain.removeHandler('class-task:methods:check');
      ipcMain.removeHandler('class-task:methods:get');
      state.__e2eManualMethodRefresh = {
        checkAttempts: 0,
        getAttempts: 0,
        request: null
      };
      ipcMain.handle('class-task:methods:check', async () => {
        state.__e2eManualMethodRefresh!.checkAttempts += 1;
        await new Promise<void>((resolve) => {
          state.__e2eManualMethodRefresh!.resolve = resolve;
        });
        return { current: true, catalog: latestCatalog };
      });
      ipcMain.handle('class-task:methods:get', async (_event, request) => {
        state.__e2eManualMethodRefresh!.getAttempts += 1;
        state.__e2eManualMethodRefresh!.request = request;
        throw new Error('prepared catalog refresh must not rebuild the method catalog');
      });
    }, refreshedCatalog);

    const refresh = methodPage.getByRole('button', { name: '刷新方法与覆盖率信息' });
    await refresh.click();

    await expect(methodPage).toBeVisible();
    await expect(methodPage.locator('.class-task-method-loading')).toHaveCount(0);
    await expect(repairLimit).toHaveValue('7');
    await expect(selectedMethod).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => app.evaluate(() => (
      (globalThis as typeof globalThis & {
        __e2eManualMethodRefresh?: { checkAttempts: number };
      }).__e2eManualMethodRefresh?.checkAttempts ?? 0
    ))).toBe(1);

    await app.evaluate(() => {
      const refreshState = (globalThis as typeof globalThis & {
        __e2eManualMethodRefresh?: { resolve?: () => void };
      }).__e2eManualMethodRefresh;
      if (!refreshState?.resolve) throw new Error('Manual method fingerprint check was not captured');
      refreshState.resolve();
    });

    await expect(methodPage.locator('.class-task-method-loading')).toHaveCount(0);
    await expect(repairLimit).toHaveValue('7');
    await expect(selectedMethod).toHaveAttribute('aria-checked', 'true');
    await expect(methodPage.locator('.class-task-method-row').first())
      .toContainText('100%');
    await expect(totalRow.locator('td').nth(2)).toHaveText('4,313 of 4,359');
    await expect(totalRow.locator('td').nth(4)).toHaveText('617 of 619');
    await expect.poll(() => app.evaluate(() => {
      const state = (globalThis as typeof globalThis & {
        __e2eManualMethodRefresh?: {
          checkAttempts: number;
          getAttempts: number;
          request: { forceReload?: boolean } | null;
        };
      }).__e2eManualMethodRefresh;
      return {
        checkAttempts: state?.checkAttempts ?? -1,
        getAttempts: state?.getAttempts ?? -1,
        request: state?.request ?? null
      };
    })).toEqual({
      checkAttempts: 1,
      getAttempts: 0,
      request: null
    });
  } finally {
    await fixture.close();
  }
});

test('manual method refresh reloads coverage when the fingerprint is current but no live catalog exists', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];

    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '配置生成方法' })
      .click();
    const methodPage = page.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();

    const currentCatalog = await page.evaluate(async ({ workspaceRoot, taskId }) => (
      (window as any).workstation.getClassTaskMethods({ workspaceRoot, taskId })
    ), { workspaceRoot: fixture.workspaceRoot, taskId: task.id });
    const refreshedCatalog = {
      ...currentCatalog,
      refreshedAt: new Date(Date.parse(currentCatalog.refreshedAt) + 1_000).toISOString(),
      methods: currentCatalog.methods.map((method: any, index: number) => index === 0
        ? {
            ...method,
            instructionCovered: 1,
            instructionMissed: 3,
            lineCovered: 1,
            lineMissed: 3,
            coverageGap: true
          }
        : method)
    };

    await app.evaluate(({ ipcMain }, latestCatalog) => {
      const state = globalThis as typeof globalThis & {
        __e2eMissingLiveMethodCatalog?: {
          checkAttempts: number;
          getAttempts: number;
        };
      };
      ipcMain.removeHandler('class-task:methods:check');
      ipcMain.removeHandler('class-task:methods:get');
      state.__e2eMissingLiveMethodCatalog = {
        checkAttempts: 0,
        getAttempts: 0
      };
      ipcMain.handle('class-task:methods:check', async () => {
        state.__e2eMissingLiveMethodCatalog!.checkAttempts += 1;
        return { current: true };
      });
      ipcMain.handle('class-task:methods:get', async () => {
        state.__e2eMissingLiveMethodCatalog!.getAttempts += 1;
        return latestCatalog;
      });
    }, refreshedCatalog);

    await methodPage.getByRole('button', { name: '刷新方法与覆盖率信息' }).click();

    await expect(methodPage.locator('.class-task-method-row').first()).toContainText('25%');
    await expect.poll(() => app.evaluate(() => {
      const state = (globalThis as typeof globalThis & {
        __e2eMissingLiveMethodCatalog?: {
          checkAttempts: number;
          getAttempts: number;
        };
      }).__e2eMissingLiveMethodCatalog;
      return {
        checkAttempts: state?.checkAttempts ?? -1,
        getAttempts: state?.getAttempts ?? -1
      };
    })).toEqual({ checkAttempts: 1, getAttempts: 1 });
  } finally {
    await fixture.close();
  }
});

test('repair round stepper aligns its value and uses compact dark controls', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '配置生成方法' })
      .click();

    const methodPage = page.locator('.class-task-method-page');
    const label = methodPage.locator('.class-task-repair-limit-label');
    const input = methodPage.getByRole('spinbutton', { name: '修复轮次' });
    const decrease = methodPage.getByRole('button', { name: '减少修复轮次' });
    const increase = methodPage.getByRole('button', { name: '增加修复轮次' });
    await expect(methodPage).toBeVisible();
    await expect(decrease).toBeVisible();
    await expect(increase).toBeVisible();

    const [labelBox, inputBox] = await Promise.all([label.boundingBox(), input.boundingBox()]);
    expect(labelBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(Math.abs(
      labelBox!.y + labelBox!.height / 2 - (inputBox!.y + inputBox!.height / 2)
    )).toBeLessThanOrEqual(1);

    const appearance = await methodPage.locator('.class-task-repair-stepper').evaluate((stepper) => {
      const inputElement = stepper.querySelector('input');
      const buttons = [...stepper.querySelectorAll('button')];
      const inputRect = inputElement!.getBoundingClientRect();
      const increaseRect = buttons[1].getBoundingClientRect();
      return {
        width: stepper.getBoundingClientRect().width,
        valueToIncreaseGap: increaseRect.left - inputRect.right,
        buttonBackgrounds: buttons.map((button) => getComputedStyle(button).backgroundColor)
      };
    });
    expect(appearance.width).toBeLessThanOrEqual(65);
    expect(Math.abs(appearance.valueToIncreaseGap)).toBeLessThanOrEqual(1);
    expect(appearance.buttonBackgrounds).not.toContain('rgb(255, 255, 255)');

    await input.fill('5');
    await increase.click();
    await expect(input).toHaveValue('6');
    await decrease.click();
    await expect(input).toHaveValue('5');
  } finally {
    await fixture.close();
  }
});

test('active method configuration keeps mutations locked while view sorting survives snapshots', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const task = (await listTasks(page, fixture.workspaceRoot))[0];

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '配置生成方法' }).click();
    const methodPage = page.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();

    const running = {
      ...task,
      state: 'RUNNING',
      preloadState: 'READY',
      currentAtomicStep: 'MODEL_GENERATION',
      updatedAt: new Date(Date.parse(task.updatedAt) + 1_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'class-task:snapshot-changed',
        snapshot
      );
    }, running);
    await expect(card.locator('.class-task-status')).toHaveText('执行中');

    await expect(methodPage.locator('.class-task-method-select-all')).toBeDisabled();
    await expect(methodPage.locator('.class-task-method-save')).toBeDisabled();
    await expect(methodPage.locator('.class-task-rag-option input')).toBeDisabled();
    await expect(methodPage.locator('.class-task-method-checkbox').first()).toBeDisabled();
    await expect(methodPage.getByRole('button', { name: '刷新方法与覆盖率信息' }))
      .toBeEnabled();

    const uncoveredLinesHeader = methodPage.getByRole('columnheader', {
      name: '未覆盖行数',
      exact: true
    });
    const uncoveredLinesSort = uncoveredLinesHeader.getByRole('button', {
      name: '未覆盖行数',
      exact: true
    });
    await expect(uncoveredLinesHeader).toHaveAttribute('aria-sort', 'none');
    await uncoveredLinesSort.click();
    await expect(uncoveredLinesHeader).toHaveAttribute('aria-sort', 'descending');

    const pausing = {
      ...running,
      state: 'PAUSE_REQUESTED',
      updatedAt: new Date(Date.parse(task.updatedAt) + 2_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'class-task:snapshot-changed',
        snapshot
      );
    }, pausing);
    await expect(card.locator('.class-task-status')).toHaveText('正在暂停');
    await expect(uncoveredLinesHeader).toHaveAttribute('aria-sort', 'descending');

    await uncoveredLinesSort.click();
    await expect(uncoveredLinesHeader).toHaveAttribute('aria-sort', 'ascending');
  } finally {
    await fixture.close();
  }
});

test('successful method configuration save shows a temporary green confirmation to the left of RAG', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '配置生成方法' }).click();
    const methodPage = page.locator('.class-task-method-page');
    const saveSuccess = methodPage.locator('.class-task-method-save-success');
    const ragControl = methodPage.locator('.class-task-rag-control');
    await expect(methodPage).toBeVisible();
    await expect(saveSuccess).toHaveCount(0);

    const selectableMethods = methodPage.locator('.class-task-method-checkbox:not(:disabled)');
    const selectableCount = await selectableMethods.count();
    expect(selectableCount).toBeGreaterThan(0);
    for (let index = 0; index < selectableCount; index += 1) {
      await expect(selectableMethods.nth(index)).toHaveAttribute('aria-checked', 'false');
    }
    await expect(methodPage.locator('.class-task-method-summary')).toHaveText(
      new RegExp(`已选择\\s*0\\s*/\\s*${selectableCount}`)
    );
    await expect(methodPage.locator('.class-task-method-select-all')).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await methodPage.locator('.class-task-method-select-all').click();
    for (let index = 0; index < selectableCount; index += 1) {
      await expect(selectableMethods.nth(index)).toHaveAttribute('aria-checked', 'true');
    }
    await expect(methodPage.locator('.class-task-method-summary')).toHaveText(
      new RegExp(`已选择\\s*${selectableCount}\\s*/\\s*${selectableCount}`)
    );
    await expect(methodPage.locator('.class-task-method-select-all')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await methodPage.getByRole('spinbutton', { name: '修复轮次' }).fill('5');
    await methodPage.locator('.class-task-method-save').click();
    await expect.poll(async () => {
      const tasks = await listTasks(page, fixture.workspaceRoot);
      return tasks[0]?.selectionMode;
    }).toBe('EXPLICIT');
    await expect(saveSuccess).toHaveText('保存成功');
    await expect(saveSuccess).toBeVisible();
    await expect(saveSuccess).toHaveCSS('border-top-color', 'rgb(69, 200, 120)');

    const [successBox, ragBox] = await Promise.all([
      saveSuccess.boundingBox(),
      ragControl.boundingBox()
    ]);
    expect((successBox?.x ?? 0) + (successBox?.width ?? 0)).toBeLessThan(ragBox?.x ?? 0);

    await expect(saveSuccess).toHaveCount(0, { timeout: 3_000 });
  } finally {
    await fixture.close();
  }
});

test('total control remains visible to the right of the title before tasks are eligible', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    const brandIcon = page.locator('.class-task-panel-brand-icon');
    const panelTitle = page.locator('.class-task-panel-title > strong');
    const idleTotalRun = page.locator('.class-task-total-control.run');
    await expect(brandIcon).toBeVisible({ timeout: 1_000 });
    await expect(idleTotalRun).toBeVisible({ timeout: 1_000 });
    await expect(idleTotalRun).toBeDisabled();
    await expect(idleTotalRun).toHaveAttribute('aria-label', '暂无可执行任务');
    const [brandBox, titleBox, totalRunBox] = await Promise.all([
      brandIcon.boundingBox(),
      panelTitle.boundingBox(),
      idleTotalRun.boundingBox()
    ]);
    expect(brandBox?.x).toBeLessThan(titleBox?.x ?? 0);
    expect(titleBox?.x).toBeLessThan(totalRunBox?.x ?? 0);
  } finally {
    await fixture.close();
  }
});

test('starting a ready task recreates an expired Analyzer session before generation', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0]);
    const classPreloadCalls = (await fixture.toolchain.readMetrics()).classPreloadMavenCalls;

    fixture.backends.expireAnalysisSessions();
    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '执行当前类' }).click();

    await waitForTaskState(page, fixture.workspaceRoot, 0, 'COMPLETED');
    await expect(card.locator('.class-task-status')).toHaveText('已完成');
    expect(fixture.backends.metrics().analysisSessionCreations).toBe(2);
    expect((await fixture.toolchain.readMetrics()).classPreloadMavenCalls)
      .toBe(classPreloadCalls);
  } finally {
    await fixture.close();
  }
});

test('wave partial Part failure still completes with the successful Part formalized', async () => {
  const fixture = await launchElectronFixture({
    modelDelayMs: 80,
    waveScenarioCount: 6,
    wavePartOutcomes: ['succeeded', 'failed']
  });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0]);

    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '执行当前类' })
      .click();
    await expect.poll(async () => (await listTasks(page, fixture.workspaceRoot))[0]?.state)
      .toMatch(/^(?:COMPLETED|FAILED)$/u);

    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    expect(task.state, JSON.stringify({
      backendErrors: fixture.backends.metrics().backendErrors,
      lastError: task.lastError
    })).toBe('COMPLETED');
    expect(task.lastError).toBeNull();
    expect(task.generatedArtifacts).toHaveLength(1);
    expect(task.generatedArtifacts[0].ordinaryTestMethodCount).toBe(5);
    const metrics = fixture.backends.metrics();
    expect(metrics.waveRequests).toHaveLength(1);
    expect(metrics.waveRequests[0].parts).toEqual([
      {
        partIndex: 1,
        scenarioIds: [1, 2, 3, 4, 5].map((index) => `scenario-uncovered-branch-${index}`)
      },
      { partIndex: 2, scenarioIds: ['scenario-uncovered-branch-6'] }
    ]);
    expect(metrics.wavePartResults.map((part: any) => part.status)).toEqual([
      'succeeded',
      'failed'
    ]);
  } finally {
    await fixture.close();
  }
});

test('all scenarios skipped after every wave Part fails reports an unusable model instead of completion', async () => {
  const fixture = await launchElectronFixture({
    modelDelayMs: 80,
    waveScenarioCount: 6,
    wavePartOutcomes: ['failed', 'failed']
  });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0]);

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '执行当前类' }).click();
    await expect.poll(async () => (await listTasks(page, fixture.workspaceRoot))[0]?.state)
      .toMatch(/^(?:COMPLETED|FAILED)$/u);

    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    expect(task.state, JSON.stringify({
      backendErrors: fixture.backends.metrics().backendErrors,
      lastError: task.lastError
    })).toBe('FAILED');
    expect(task.lastError?.code).toBe('MODEL_NO_FORMAL_TEST_FILE_GENERATED');
    expect(task.lastError?.message).toContain('MODEL_FAILED: fixture Part 1 failed');
    expect(task.generatedArtifacts).toEqual([]);
    expect(fixture.backends.metrics().wavePartResults.map((part: any) => part.status))
      .toEqual(['failed', 'failed']);

    await expect(card.locator('.class-task-status')).toHaveText('所选模型不可用');
    const details = card.locator('.class-task-card-error-anchor');
    await expect(details).toHaveText('查看详情');
    await details.hover();
    await expect(page.locator('.class-task-card-error-popover'))
      .toContainText('MODEL_FAILED: fixture Part 1 failed');
  } finally {
    await fixture.close();
  }
});

test('wave generation pages 55 scenarios as 25 25 5 with at most five concurrent Parts', async () => {
  const fixture = await launchElectronFixture({
    modelDelayMs: 30,
    waveScenarioCount: 55
  });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0]);

    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '执行当前类' })
      .click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'COMPLETED');

    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    expect(task.generatedArtifacts.map((artifact: any) => artifact.ordinaryTestMethodCount))
      .toEqual([25, 25, 5]);
    const metrics = fixture.backends.metrics();
    expect(metrics.waveRequests.map((request: any) => request.waveIndex)).toEqual([1, 2, 3]);
    expect(metrics.waveRequests.map((request: any) => (
      request.parts.reduce(
        (total: number, part: any) => total + part.scenarioIds.length,
        0
      )
    ))).toEqual([25, 25, 5]);
    expect(metrics.waveRequests.map((request: any) => request.parts.length)).toEqual([5, 5, 1]);
    expect(metrics.maxConcurrentModelCalls).toBe(5);
  } finally {
    await fixture.close();
  }
});

test('wave candidates from three cards opportunistically batch without overlapping same-module Maven', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 80 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 3), '.class-task-card-list');
    await waitForTaskStates(page, fixture.workspaceRoot, Array(3).fill('READY'));
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0, 1, 2]);

    await page.locator('.class-task-total-control.run').click();
    await waitForTaskStates(page, fixture.workspaceRoot, Array(3).fill('COMPLETED'));

    const invocations = (await fixture.toolchain.readMetrics()).invocations;
    const generatedSelectors = invocations
      .filter((invocation: any) => invocation.args.includes('test-compile'))
      .flatMap((invocation: any) => invocation.args
        .filter((argument: string) => argument.startsWith('-Dtest='))
        .map((argument: string) => argument.slice('-Dtest='.length)));
    const tmpSelectors = generatedSelectors.filter((selector: string) => (
      selector.split(',').some((className: string) => /Tmp\d+Test$/u.test(className))
    ));
    expect(
      [...new Set(tmpSelectors.flatMap((selector: string) => selector.split(',')))].sort()
    ).toEqual(CLASS_NAMES.slice(0, 3).map((className) => (
      `com.example.${className}Tmp1Test`
    )).sort());
    expect(
      tmpSelectors.some((selector: string) => selector.split(',').length > 1),
      JSON.stringify(tmpSelectors)
    ).toBe(true);
    expect((await fixture.toolchain.readMetrics()).sameModuleConcurrencyViolations).toBe(0);
    expect(fixture.backends.metrics().waveRequests).toHaveLength(3);
  } finally {
    await fixture.close();
  }
});

test('stable repair comments the remaining failed test after the finite model repair limit', async () => {
  const fixture = await launchElectronFixture({
    modelDelayMs: 30,
    waveScenarioCount: 2,
    repairFailedCandidate: true,
    failGeneratedTestMethodName: 'coversGeneratedPathPart1_1'
  });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0], 1);

    await page.locator('.class-task-card').first()
      .getByRole('button', { name: '执行当前类' })
      .click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'COMPLETED');

    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    expect(task.generatedArtifacts).toHaveLength(1);
    expect(task.generatedArtifacts[0].ordinaryTestMethodCount).toBe(1);
    const source = await readFile(task.generatedArtifacts[0].filePath, 'utf8');
    expect(source).toContain('// TODO 当前测试方法需要修复');
    expect(source).toMatch(/\/\/\s+void coversGeneratedPathPart1_1\(\)/u);
    expect(source).toMatch(/^\s*void coversGeneratedPathPart1_2\(\)/mu);
    expect(fixture.backends.metrics().ragResumeRequests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('five class tasks complete through Electron and retain accepted or revoked ownership', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await expect(
      page.getByText('添加生产源码类后，将在这里显示独立任务。', { exact: true })
    ).toHaveCount(0);
    await addFiveClassTasks(fixture);

    const cards = page.locator('.class-task-card');
    await expect(cards).toHaveCount(5);
    await expect.poll(() => cardStatuses(page), { timeout: 30_000 }).toEqual(
      Array(5).fill('待执行')
    );
    await expect(page.locator('.class-task-total-control.run')).toBeDisabled();

    // The first class exercises the visible method-selection flow. The remaining
    // cards use the same explicit contract through the typed preload bridge.
    await cards.nth(0).getByRole('button', { name: '配置生成方法' }).click();
    const methodPage = page.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();
    const methodSearch = methodPage.getByRole('searchbox', { name: '可在此处搜索方法' });
    await expect(methodSearch).toHaveAttribute('placeholder', '可在此处搜索方法');
    await expect(methodSearch).toHaveCSS('font-size', '12px');
    await methodPage.locator('.class-task-method-row').click();
    await methodPage.getByRole('spinbutton', { name: '修复轮次' }).fill('5');
    await methodPage.locator('.class-task-method-save').click();
    await expect.poll(async () => {
      const tasks = await listTasks(page, fixture.workspaceRoot);
      return tasks[0]?.selectionMode;
    }).toBe('EXPLICIT');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [1, 2, 3, 4]);
    await expect(page.locator('.class-task-total-control.run')).toBeEnabled();

    await page.locator('.class-task-total-control.run').click();
    await expect.poll(() => cardStatuses(page), { timeout: 60_000 }).toEqual(
      Array(5).fill('已完成')
    );
    await expect(page.locator('.class-task-total-control.run')).toBeDisabled();
    await expect(cards.nth(0).getByRole('button', { name: '执行当前类' })).toBeDisabled();
    await expect(cards.nth(4).getByRole('button', { name: '执行当前类' })).toBeDisabled();

    const backendMetrics = fixture.backends.metrics();
    expect(backendMetrics.realModelCalls).toBe(0);
    expect(backendMetrics.agentRequests).toHaveLength(5);
    expect(backendMetrics.agentRequests.every((request) => (
      request.batchHasWork === true
      && request.plannedTestMethods >= 1
      && request.plannedTestMethods <= 12
    ))).toBe(true);
    const mavenMetrics = await fixture.toolchain.readMetrics();
    expect(mavenMetrics.modulePreloadMavenCalls).toBe(0);
    expect(mavenMetrics.classPreloadMavenCalls).toBe(5);
    expect(mavenMetrics.sameModuleConcurrencyViolations).toBe(0);

    await cards.nth(0).click();
    const resultPage = page.locator('.class-task-result-dialog');
    await expect(resultPage).toBeVisible();
    await expect(resultPage).toHaveAttribute('aria-modal', 'true');

    const resultHeader = resultPage.locator('.class-task-result-header');
    await expect(resultHeader).toHaveCSS('cursor', 'default');
    const [resultBeforeDrag, resultHeaderBox] = await Promise.all([
      resultPage.boundingBox(),
      resultHeader.boundingBox()
    ]);
    expect(resultBeforeDrag).not.toBeNull();
    expect(resultHeaderBox).not.toBeNull();
    await page.mouse.move(
      resultHeaderBox!.x + resultHeaderBox!.width / 2,
      resultHeaderBox!.y + resultHeaderBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      resultHeaderBox!.x + resultHeaderBox!.width / 2 + 64,
      resultHeaderBox!.y + resultHeaderBox!.height / 2 + 40
    );
    await page.mouse.up();
    const resultAfterDrag = await resultPage.boundingBox();
    expect(resultAfterDrag).not.toBeNull();
    expect(resultAfterDrag!.x - resultBeforeDrag!.x).toBeGreaterThan(48);
    expect(resultAfterDrag!.y - resultBeforeDrag!.y).toBeGreaterThan(24);

    await expect(resultPage.locator('.class-task-coverage-card')).toHaveCount(2);
    await expect(resultPage.getByText('生成已完成', { exact: true })).toBeVisible();
    await expect(resultPage.getByText('覆盖情况', { exact: true })).toBeVisible();
    await expect(resultPage.locator('.class-task-coverage-card').nth(0))
      .toContainText('行覆盖率');
    await expect(resultPage.locator('.class-task-coverage-card').nth(1))
      .toContainText('分支覆盖率');
    const methodResult = resultPage.locator('.class-task-result-generation-list article').first();
    await expect(methodResult.locator('code')).toHaveText('value');
    await expect(methodResult.locator('b')).toHaveText('1 个测试');
    await expect(resultPage.locator('.class-task-result-generation-list')).not.toContainText(/[0-9a-f]{64}/i);
    const addedCoverageSegment = resultPage
      .locator('.class-task-coverage-segment.added.interactive')
      .first();
    const addedCoveragePoint = await visibleArcPosition(addedCoverageSegment);
    await resultPage.locator('.class-task-coverage-ring').first().click({
      position: addedCoveragePoint
    });
    await expect(resultPage.getByText('行覆盖率新增详情', { exact: true })).toBeVisible();
    await expect(resultPage.locator('.class-task-result-detail-table')).toBeVisible();
    await resultPage.getByRole('button', { name: '返回结果页' }).click();

    const currentCoverageLabels = await resultPage
      .locator('.class-task-result-change-values > b:nth-of-type(2)')
      .allTextContents();
    await resultPage.locator('.class-task-result-actions .primary').click();
    await expect(resultPage).toBeHidden();
    await expect.poll(async () => {
      const accepted = (await listTasks(page, fixture.workspaceRoot))[0];
      return accepted.generatedArtifacts.length === 1
        && accepted.generatedArtifacts[0].accepted;
    }).toBe(true);
    await expect(cards.nth(0).getByRole('button', { name: '执行当前类' })).toBeEnabled();

    await cards.nth(0).click();
    await expect(resultPage).toBeVisible();
    await expect(resultPage.getByText('当前覆盖率', { exact: true })).toBeVisible();
    await expect(resultPage.locator('.class-task-result-change-values > b'))
      .toHaveText(currentCoverageLabels);
    await expect(resultPage.locator('.class-task-result-change-values > i')).toHaveCount(0);
    await expect(resultPage.locator('.class-task-result-change-values > em')).toHaveCount(0);
    await expect(resultPage.locator('.class-task-result-change-bar > span.original').first())
      .toHaveCSS('background-color', 'rgb(98, 185, 133)');
    await expect(resultPage.locator('.class-task-result-change-bar > span.added').first())
      .toHaveCSS('width', '0px');
    await resultPage.getByRole('button', { name: '关闭运行结果' }).click();

    await cards.nth(1).click();
    await expect(resultPage).toBeVisible();
    await resultPage.getByRole('button', { name: '撤回' }).click();
    await expect(resultPage).toBeHidden();
    await expect.poll(async () => (
      (await listTasks(page, fixture.workspaceRoot))[1].generatedArtifacts.length
    )).toBe(0);

    const tasks = await listTasks(page, fixture.workspaceRoot);
    expect(tasks[0].generatedArtifacts).toHaveLength(1);
    expect(tasks[0].generatedArtifacts[0].accepted).toBe(true);
    expect(tasks[1].generatedArtifacts).toHaveLength(0);
    await expect(cards.nth(1).getByRole('button', { name: '执行当前类' })).toBeEnabled();
    await expect(page.locator('.class-task-total-control.run')).toBeEnabled();
    await expect(page.locator('.class-task-total-control.run'))
      .toHaveAttribute('aria-label', '执行其余 2 个任务');

    await cards.nth(1).click();
    await expect(resultPage).toBeVisible();
    await expect(resultPage.locator('.class-task-result-metrics')).toContainText('0 个');
  } finally {
    await fixture.close();
  }
});

test('manual refresh removes accepted coverage after its test file is deleted externally', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0]);

    const card = page.locator('.class-task-card').first();
    await card.getByRole('button', { name: '执行当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'COMPLETED');
    await card.click();

    const resultPage = page.locator('.class-task-result-dialog');
    await expect(resultPage).toBeVisible();
    await resultPage.locator('.class-task-result-actions .primary').click();
    await expect(resultPage).toBeHidden();
    await expect.poll(async () => {
      const accepted = (await listTasks(page, fixture.workspaceRoot))[0];
      return accepted.generatedArtifacts.length === 1
        && accepted.generatedArtifacts[0].accepted;
    }).toBe(true);

    const acceptedTask = (await listTasks(page, fixture.workspaceRoot))[0];
    expect(acceptedTask.generatedArtifacts).toHaveLength(1);
    expect(acceptedTask.generatedArtifacts[0].accepted).toBe(true);
    const acceptedTestFilePath = acceptedTask.generatedArtifacts[0].filePath;
    await card.getByRole('button', { name: '配置生成方法' }).click();
    const methodPage = page.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();
    await expect(methodPage.locator('.class-task-method-row').first()).toContainText('100%');

    await rm(acceptedTestFilePath);
    await methodPage.getByRole('button', { name: '刷新方法与覆盖率信息' }).click();

    await expect.poll(async () => (
      (await listTasks(page, fixture.workspaceRoot))[0]?.generatedArtifacts.length
    )).toBe(0);
    await expect(card.locator('.class-task-card-test-summary')).toHaveCount(0);
    await expect(methodPage.locator('.class-task-method-row').first()).toContainText('0%');
  } finally {
    await fixture.close();
  }
});

test('individual class controls pause, resume, and terminate without starting sibling tasks', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 700 });
  try {
    const { page } = fixture;
    await addFiveClassTasks(fixture);
    await waitForTaskStates(page, fixture.workspaceRoot, Array(5).fill('READY'));
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0, 1]);

    const cards = page.locator('.class-task-card');
    await cards.nth(0).getByRole('button', { name: '执行当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'RUNNING');
    const elapsedTime = cards.nth(0).locator('.class-task-card-elapsed');
    await expect(elapsedTime).toBeVisible();
    await expect(elapsedTime).toHaveText(/^\d{2,}:\d{2}:\d{2}$/);

    const actionArea = cards.nth(0).locator('.class-task-card-actions');
    const deleteAction = cards.nth(0).getByRole('button', { name: '删除当前任务' });
    await expect(deleteAction).toBeVisible();
    const [actionAreaBox, deleteActionBox] = await Promise.all([
      actionArea.boundingBox(),
      deleteAction.boundingBox()
    ]);
    expect(actionAreaBox).not.toBeNull();
    expect(deleteActionBox).not.toBeNull();
    expect(Math.abs(
      (actionAreaBox!.x + actionAreaBox!.width)
      - (deleteActionBox!.x + deleteActionBox!.width)
    )).toBeLessThanOrEqual(1);

    await expect.poll(() => fixture.backends.metrics().waveRequests.length).toBe(1);
    const waveStartsBeforePause = fixture.backends.metrics().waveRequests.length;
    await cards.nth(0).getByRole('button', { name: '暂停当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'PAUSED');
    await expect(cards.nth(0).locator('.class-task-status')).toHaveText('已暂停');
    expect(fixture.backends.metrics().waveRequests).toHaveLength(waveStartsBeforePause);

    await cards.nth(0).getByRole('button', { name: '继续当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'COMPLETED');
    await expect(cards.nth(0).locator('.class-task-status')).toHaveText('已完成');
    expect(fixture.backends.metrics().waveRequests).toHaveLength(waveStartsBeforePause);

    await cards.nth(1).getByRole('button', { name: '执行当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 1, 'RUNNING');
    await cards.nth(1).getByRole('button', { name: '终止当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 1, 'TERMINATED');
    await expect(cards.nth(1).locator('.class-task-status')).toHaveText('已终止');
    await expect(cards.nth(1).locator('.class-task-card-summary .class-task-card-progress-label'))
      .toHaveText(/^已完成 \d+\/\d+ 个方法$/);
    await expect(cards.nth(1).locator('.class-task-card-progress-track')).toHaveCount(0);

    const tasks = await listTasks(page, fixture.workspaceRoot);
    expect(tasks.slice(2).map((task) => task.state)).toEqual(Array(3).fill('READY'));
    expect(fixture.backends.metrics().realModelCalls).toBe(0);
    expect((await fixture.toolchain.readMetrics()).sameModuleConcurrencyViolations).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('a ready class task is deleted immediately together with its method configuration tab', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');

    const cards = page.locator('.class-task-card');
    await expect(cards).toHaveCount(1);
    await cards.first().getByRole('button', { name: '配置生成方法' }).click();
    const task = (await listTasks(page, fixture.workspaceRoot))[0];
    const configurationTab = page.locator('.editor-tab', {
      hasText: `${task.qualifiedClassName.split('.').pop()} · 方法`
    });
    await expect(configurationTab).toHaveCount(1);
    await expect(page.locator('.class-task-method-page')).toBeVisible();

    await cards.first().getByRole('button', { name: '删除当前任务' }).click();
    await expect(page.getByRole('dialog', { name: '删除任务？' })).toHaveCount(0);
    await expect(cards).toHaveCount(0);
    await expect(configurationTab).toHaveCount(0);
    await expect(page.locator('.class-task-method-page')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('a late snapshot cannot resurrect a task after deletion succeeds', async () => {
  // Mutation caught: accepting every snapshot event lets an in-flight command or delayed
  // main-process broadcast recreate a renderer-only ghost card after durable deletion.
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const [deletedTask] = await listTasks(page, fixture.workspaceRoot);

    const cards = page.locator('.class-task-card');
    await cards.first().getByRole('button', { name: '删除当前任务' }).click();
    await expect(cards).toHaveCount(0);
    expect(await listTasks(page, fixture.workspaceRoot)).toEqual([]);

    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, deletedTask);

    await page.waitForTimeout(100);
    await expect(cards).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('a preloading class task is deleted immediately without confirmation', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    const [task] = await listTasks(page, fixture.workspaceRoot);
    const preloading = {
      ...task,
      state: 'PRELOADING',
      preloadState: 'RUNNING',
      updatedAt: new Date(Date.parse(task.updatedAt) + 1_000).toISOString()
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, preloading);

    const card = page.locator('.class-task-card').first();
    await expect(card.locator('.class-task-status')).toHaveText('正在预加载');
    await card.getByRole('button', { name: '删除当前任务' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.class-task-card')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('a terminated result awaiting a decision flashes yellow and cannot rerun', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    const { app, page } = fixture;
    await dropClassTasks(fixture, fixture.sourceFilePaths.slice(0, 1), '.class-task-card-list');
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'READY');
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0]);
    const [task] = await listTasks(page, fixture.workspaceRoot);
    const now = new Date(Date.parse(task.updatedAt) + 1_000).toISOString();
    const terminated = {
      ...task,
      state: 'TERMINATED',
      completionAttentionPending: true,
      generatedArtifacts: [{
        id: 'terminated-artifact',
        filePath: join(fixture.workspaceRoot, 'src', 'test', 'java', 'com', 'example', 'AlphaService1Test.java'),
        testClassName: 'AlphaService1Test',
        ordinaryTestMethodCount: 1,
        methodIds: [task.selectedMethodIds[0]],
        sha256: 'a'.repeat(64),
        sealed: true,
        accepted: false,
        createdAt: now,
        updatedAt: now
      }],
      coverageBaseline: {
        lineCovered: 0, lineMissed: 1, lineTotal: 1,
        branchCovered: 0, branchMissed: 2, branchTotal: 2
      },
      coverageCurrent: {
        lineCovered: 1, lineMissed: 0, lineTotal: 1,
        branchCovered: 1, branchMissed: 1, branchTotal: 2
      },
      updatedAt: now
    };
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('class-task:snapshot-changed', snapshot);
    }, terminated);

    const card = page.locator('.class-task-card').first();
    await expect(card.locator('.class-task-status')).toHaveText('已终止');
    await expect(card).toHaveClass(/\bclass-task-termination-pulse\b/);
    await expect(card.getByRole('button', { name: '执行当前类' })).toBeDisabled();
    await expect(page.locator('.class-task-total-control.run')).toBeDisabled();
    const animation = await card.evaluate((element) => element.getAnimations().map((item) => ({
      name: (item as CSSAnimation).animationName,
      borderColors: (item.effect as KeyframeEffect).getKeyframes()
        .map((frame) => String(frame.borderTopColor ?? ''))
    })));
    expect(animation.some((item) => item.name === 'class-task-termination-pulse')).toBe(true);
    expect(animation.flatMap((item) => item.borderColors)).toContain('rgb(211, 168, 78)');
  } finally {
    await fixture.close();
  }
});

test('total run starts remaining classes and total terminate requires confirmation', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 2_000 });
  try {
    const { page } = fixture;
    await addFiveClassTasks(fixture);
    await waitForTaskStates(page, fixture.workspaceRoot, Array(5).fill('READY'));
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0, 1, 2, 3, 4]);

    const cards = page.locator('.class-task-card');
    await cards.nth(0).getByRole('button', { name: '执行当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'RUNNING');

    const runRemaining = page.locator('.class-task-total-control.run');
    await expect(runRemaining).toHaveAttribute('aria-label', '执行其余 4 个任务');
    await runRemaining.click();
    await expect(runRemaining).toBeDisabled();
    await expect(runRemaining).toHaveAttribute('aria-label', '正在执行批量任务');
    await expect(runRemaining.locator('svg.lucide-loader-circle')).toHaveCount(1);
    await waitForTaskStates(page, fixture.workspaceRoot, Array(5).fill('RUNNING'));

    const terminateAll = page.locator('.class-task-total-control.terminate');
    await expect(terminateAll).toHaveAttribute('title', '终止全部任务');
    await expect(terminateAll).toHaveAttribute('aria-label', '终止全部任务');
    await expect(terminateAll.locator('svg.lucide-square')).toHaveCount(1);
    await expect(terminateAll).toHaveText('');
    await expect(terminateAll).toBeEnabled();
    await terminateAll.click();
    const dialog = page.getByRole('dialog', { name: '终止全部任务？' });
    await expect(dialog).toContainText('将终止 5 个正在执行或暂停的任务');
    await dialog.getByRole('button', { name: '终止', exact: true }).click();

    await waitForTaskStates(page, fixture.workspaceRoot, Array(5).fill('TERMINATED'));
    await expect(page.locator('.class-task-card .class-task-status')).toHaveText(
      Array(5).fill('已终止')
    );
    expect(fixture.backends.metrics().realModelCalls).toBe(0);
    expect((await fixture.toolchain.readMetrics()).sameModuleConcurrencyViolations).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('a task deleted during total run stays deleted after the slower sibling terminates', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 2_000 });
  try {
    const { page } = fixture;
    await dropClassTasks(
      fixture,
      fixture.sourceFilePaths.slice(0, 2),
      '.class-task-card-list'
    );
    await waitForTaskStates(page, fixture.workspaceRoot, ['READY', 'READY']);
    await configureGeneratableMethods(page, fixture.workspaceRoot, [0, 1]);
    const initialTasks = await listTasks(page, fixture.workspaceRoot);
    const deletedTask = initialTasks[1];

    const cards = page.locator('.class-task-card');
    await page.locator('.class-task-total-control.run').click();
    await waitForTaskStates(page, fixture.workspaceRoot, ['RUNNING', 'RUNNING']);

    await cards.nth(1).getByRole('button', { name: '终止当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 1, 'TERMINATED');
    const terminatedTask = (await listTasks(page, fixture.workspaceRoot))[1];
    await cards.nth(1).getByRole('button', { name: '删除当前任务' }).click();
    if (terminatedTask.generatedArtifacts.some((artifact) => !artifact.accepted)) {
      await page.getByRole('dialog', { name: '删除任务？' })
        .getByRole('button', { name: '删除', exact: true })
        .click();
    }
    await expect(cards).toHaveCount(1);
    await expect.poll(async () => (
      (await listTasks(page, fixture.workspaceRoot)).map((task) => task.id)
    )).not.toContain(deletedTask.id);

    await cards.first().getByRole('button', { name: '终止当前类' }).click();
    await waitForTaskState(page, fixture.workspaceRoot, 0, 'TERMINATED');

    await expect(cards).toHaveCount(1);
    await expect(cards.first()).not.toContainText(
      deletedTask.qualifiedClassName.split('.').at(-1) as string
    );
    expect((await listTasks(page, fixture.workspaceRoot)).map((task) => task.id))
      .toEqual([initialTasks[0].id]);
  } finally {
    await fixture.close();
  }
});

test('restart preserves an unchanged ready task with no selected methods and no repeated class preload', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    await dropClassTasks(
      fixture,
      fixture.sourceFilePaths.slice(0, 1),
      '.class-task-card-list'
    );
    await waitForTaskState(fixture.page, fixture.workspaceRoot, 0, 'READY');

    const cardBeforeRestart = fixture.page.locator('.class-task-card').first();
    await cardBeforeRestart.getByRole('button', { name: '配置生成方法' }).click();
    await expect(fixture.page.locator('.class-task-method-page')).toBeVisible();
    await expect.poll(async () => fixture.page.evaluate(async (workspaceRoot) => {
      const state = await (window as any).workstation.getWorkspaceViewState(workspaceRoot);
      const methodTab = state?.workbenchTabs?.find(
        (tab: any) => tab.kind === 'method_configuration'
      );
      return methodTab?.catalog?.fingerprint ?? null;
    }, fixture.workspaceRoot)).toMatch(/^[0-9a-f]{64}$/);

    const mavenBeforeRestart = await fixture.toolchain.readMetrics();
    const analysisSessionsBeforeRestart = fixture.backends.metrics().analysisSessionCreations;
    expect(mavenBeforeRestart.classPreloadMavenCalls).toBe(1);

    const restartedPage = await fixture.restart();
    await waitForTaskState(restartedPage, fixture.workspaceRoot, 0, 'READY');
    await restartedPage.waitForTimeout(500);

    expect(fixture.backends.metrics().analysisSessionCreations)
      .toBe(analysisSessionsBeforeRestart);
    expect((await fixture.toolchain.readMetrics()).classPreloadMavenCalls)
      .toBe(mavenBeforeRestart.classPreloadMavenCalls);

    const restartedCard = restartedPage.locator('.class-task-card').first();
    const methodPage = restartedPage.locator('.class-task-method-page');
    await expect(methodPage).toBeVisible();
    await expect(restartedPage.locator('.class-task-method-loading')).toHaveCount(0);
    await expect(methodPage.locator('.class-task-method-summary'))
      .toHaveText(/已选择\s*0\s*\/\s*\d+/);
    await expect(methodPage.locator('.class-task-method-checkbox[aria-checked="true"]'))
      .toHaveCount(0);

    await restartedCard.getByRole('button', { name: '执行当前类' }).click();
    await expect(restartedCard.locator('.class-task-card-selection-hint'))
      .toHaveText('请先选择至少一个方法');
    await expect.poll(async () => (await listTasks(restartedPage, fixture.workspaceRoot))[0]?.state)
      .toBe('READY');

    expect((await fixture.toolchain.readMetrics()).classPreloadMavenCalls)
      .toBe(mavenBeforeRestart.classPreloadMavenCalls);
    expect(fixture.backends.metrics().realModelCalls).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('restart reloads a persisted method catalog only after the class fingerprint changes', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 250 });
  try {
    await dropClassTasks(
      fixture,
      fixture.sourceFilePaths.slice(0, 1),
      '.class-task-card-list'
    );
    await waitForTaskState(fixture.page, fixture.workspaceRoot, 0, 'READY');

    await fixture.page.locator('.class-task-card').first()
      .getByRole('button', { name: '配置生成方法' })
      .click();
    await expect(fixture.page.locator('.class-task-method-page')).toBeVisible();
    await expect.poll(async () => fixture.page.evaluate(async (workspaceRoot) => {
      const state = await (window as any).workstation.getWorkspaceViewState(workspaceRoot);
      return state?.workbenchTabs?.find(
        (tab: any) => tab.kind === 'method_configuration'
      )?.catalog?.fingerprint ?? '';
    }, fixture.workspaceRoot)).toMatch(/^[0-9a-f]{64}$/);

    const mavenBeforeRestart = await fixture.toolchain.readMetrics();
    const sessionsBeforeRestart = fixture.backends.metrics().analysisSessionCreations;
    await appendFile(fixture.sourceFilePaths[0], '\n// E2E fingerprint change\n', 'utf8');

    const restartedPage = await fixture.restart();
    await expect(restartedPage.locator('.class-task-method-page')).toBeVisible();
    await expect.poll(() => fixture.backends.metrics().analysisSessionCreations)
      .toBe(sessionsBeforeRestart + 1);
    await expect.poll(async () => (await fixture.toolchain.readMetrics()).classPreloadMavenCalls)
      .toBe(mavenBeforeRestart.classPreloadMavenCalls + 1);
    await expect(restartedPage.locator('.class-task-method-loading')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('restart marks an active class interrupted and never resumes model work automatically', async () => {
  const fixture = await launchElectronFixture({ modelDelayMs: 2_000 });
  try {
    await addFiveClassTasks(fixture);
    await waitForTaskStates(fixture.page, fixture.workspaceRoot, Array(5).fill('READY'));
    await configureGeneratableMethods(fixture.page, fixture.workspaceRoot, [0]);

    await fixture.page.locator('.class-task-card').nth(0)
      .getByRole('button', { name: '执行当前类' })
      .click();
    await waitForTaskState(fixture.page, fixture.workspaceRoot, 0, 'RUNNING');
    await expect.poll(() => fixture.backends.metrics().agentRequests.length).toBe(1);
    const modelRequestsBeforeRestart = fixture.backends.metrics().agentRequests.length;
    const waveStartsBeforeRestart = fixture.backends.metrics().waveRequests.length;
    expect(waveStartsBeforeRestart).toBe(1);

    const restartedPage = await fixture.restart();
    await waitForTaskState(restartedPage, fixture.workspaceRoot, 0, 'INTERRUPTED');
    await expect(restartedPage.locator('.class-task-card').nth(0).locator('.class-task-status'))
      .toHaveText('已中断');
    await restartedPage.waitForTimeout(500);

    const tasks = await listTasks(restartedPage, fixture.workspaceRoot);
    expect(tasks.slice(1).map((task) => task.state)).toEqual(Array(4).fill('READY'));
    expect(fixture.backends.metrics().agentRequests).toHaveLength(modelRequestsBeforeRestart);
    expect(fixture.backends.metrics().waveRequests).toHaveLength(waveStartsBeforeRestart);
    expect(fixture.backends.metrics().realModelCalls).toBe(0);
  } finally {
    await fixture.close();
  }
});

async function launchElectronFixture(options: {
  modelDelayMs: number;
  waveScenarioCount?: number | Record<string, number>;
  wavePartOutcomes?: Array<'succeeded' | 'failed'>;
  repairFailedCandidate?: boolean;
  failGeneratedTestMethodName?: string;
}): Promise<ElectronFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aiut-playwright-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  const userDataRoot = join(temporaryRoot, 'user-data');
  await cp(FIXTURE_ROOT, workspaceRoot, { recursive: true });
  await rm(join(workspaceRoot, 'target'), { recursive: true, force: true });

  const sourceFilePaths = CLASS_NAMES.map((className) => join(
    workspaceRoot,
    'src',
    'main',
    'java',
    'com',
    'example',
    `${className}.java`
  ));
  const backends = await startFakeBackendServers(options);
  const toolchain = await createFakeMavenHome(options);
  const startApp = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await electron.launch({
      args: ['--disable-gpu', '--no-sandbox', '.', `--user-data-dir=${userDataRoot}`],
      cwd: WORKSTATION_ROOT,
      env: {
        ...stringEnvironment(process.env),
        AI_UNIT_TEST_E2E_BACKEND_RUNTIME: 'enabled',
        AI_UNIT_TEST_E2E_AGENT_URL: backends.agentServiceUrl,
        AI_UNIT_TEST_E2E_ANALYZER_URL: backends.javaAnalyzerUrl,
        WORKSTATION_E2E_MODEL_KEY: 'fixture-not-used',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    expect(normalizePath(await app.evaluate(({ app: electronApp }) => (
      electronApp.getPath('userData')
    )))).toBe(normalizePath(userDataRoot));
    await expect.poll(async () => page.evaluate(async () => (
      (window as any).workstation.getManagedBackendRuntimeStatus()
    ))).toMatchObject({ state: 'ready' });
    return { app, page };
  };
  let running: { app: ElectronApplication; page: Page } | null = null;
  try {
    running = await startApp();

    const setup = await running.page.evaluate(async ({ mavenHome, javaHome, agentServiceUrl }) => {
      const api = (window as any).workstation;
      const build = await api.saveWorkstationBuildSettings({ mavenHome, javaHome });
      const created = await api.createModelInterface({
        name: 'Electron E2E fixture',
        baseUrl: `${agentServiceUrl}/v1`,
        model: 'fixture-only',
        credentialMode: 'environment',
        environmentVariableName: 'WORKSTATION_E2E_MODEL_KEY'
      });
      const modelId = created.interfaces[0]?.id;
      if (!modelId) throw new Error('fixture model interface was not created');
      const selected = await api.selectModelInterface({ id: modelId });
      return {
        buildValid: build.validation?.valid === true,
        activeInterfaceId: selected.activeInterfaceId
      };
    }, {
      mavenHome: toolchain.mavenHome,
      javaHome: toolchain.javaHome,
      agentServiceUrl: backends.agentServiceUrl
    });
    expect(setup.buildValid).toBe(true);
    expect(setup.activeInterfaceId).toBeTruthy();

    await running.app.evaluate(async ({ dialog }, selectedWorkspace) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedWorkspace]
      });
    }, workspaceRoot);
    await running.page.getByTitle('打开工作区').click();
    await expect(running.page.locator('.workspace-caption')).toContainText(basename(workspaceRoot).toUpperCase());

    let closed = false;
    return {
      get app() {
        if (!running) throw new Error('Electron fixture is not running');
        return running.app;
      },
      get page() {
        if (!running) throw new Error('Electron fixture is not running');
        return running.page;
      },
      workspaceRoot,
      userDataRoot,
      sourceFilePaths,
      backends,
      toolchain,
      async restart() {
        if (closed || !running) throw new Error('Electron fixture is closed');
        await running.app.close();
        running = await startApp();
        await expect(running.page.locator('.workspace-caption')).toContainText(
          basename(workspaceRoot).toUpperCase()
        );
        return running.page;
      },
      async close() {
        if (closed) return;
        closed = true;
        await running?.app.close().catch(() => undefined);
        await Promise.all([
          backends.close(),
          toolchain.close()
        ]);
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await running?.app.close().catch(() => undefined);
    await Promise.allSettled([backends.close(), toolchain.close()]);
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function addFiveClassTasks(fixture: ElectronFixture): Promise<void> {
  await dropClassTasks(fixture, fixture.sourceFilePaths, '.class-task-card-list');
}

async function configureGeneratableMethods(
  page: Page,
  workspaceRoot: string,
  taskIndexes: number[],
  repairAttemptLimit = 5
): Promise<void> {
  await page.evaluate(async ({ root, indexes, repairLimit }) => {
    const api = (window as any).workstation;
    const tasks = await api.listClassTasks({ workspaceRoot: root });
    await Promise.all(indexes.map(async (index: number) => {
      const task = tasks[index];
      if (!task) throw new Error(`Missing class-task fixture at index ${index}`);
      const catalog = await api.getClassTaskMethods({ workspaceRoot: root, taskId: task.id });
      const methodOrder = catalog.methods
        .filter((method: any) => method.generatable && method.coverageGap !== false)
        .map((method: any) => method.methodId);
      if (methodOrder.length === 0) {
        throw new Error(`Class-task fixture at index ${index} has no generatable method`);
      }
      await api.saveClassTaskMethodSelection({
        workspaceRoot: root,
        taskId: task.id,
        selectionMode: 'EXPLICIT',
        selectedMethodIds: methodOrder,
        methodOrder,
        ragEnabled: false,
        repairAttemptLimit: repairLimit,
        unlimitedRepair: false
      });
    }));
  }, { root: workspaceRoot, indexes: taskIndexes, repairLimit: repairAttemptLimit });
}

async function readResizableEditorGeometry(page: Page): Promise<{
  editorWidth: number;
  agentWidth: number;
  handleLeft: number;
  hostRight: number;
  monacoRight: number;
  minimapRight: number;
  verticalScrollbarRight: number;
}> {
  return page.evaluate(() => {
    const requiredRect = (selector: string): DOMRect => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      return element.getBoundingClientRect();
    };
    const editor = requiredRect('.editor-column');
    const agent = requiredRect('.class-task-agent-panel');
    const handle = document.querySelectorAll<HTMLElement>('.resize-handle')[1]?.getBoundingClientRect();
    if (!handle) throw new Error('Missing right resize handle');
    const host = requiredRect('.local-monaco-editor-host');
    const monaco = requiredRect('.local-monaco-editor-host .monaco-editor');
    const minimap = requiredRect('.local-monaco-editor-host .minimap');
    const verticalScrollbar = requiredRect(
      '.local-monaco-editor-host .monaco-scrollable-element > .scrollbar.vertical'
    );
    return {
      editorWidth: editor.width,
      agentWidth: agent.width,
      handleLeft: handle.left,
      hostRight: host.right,
      monacoRight: monaco.right,
      minimapRight: minimap.right,
      verticalScrollbarRight: verticalScrollbar.right
    };
  });
}

async function dropClassTasks(
  fixture: ElectronFixture,
  sourceFilePaths: string[],
  targetSelector: string
): Promise<void> {
  await fixture.page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'e2e-native-file-source';
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
  });
  const source = fixture.page.locator('#e2e-native-file-source');
  await source.setInputFiles(sourceFilePaths);
  await fixture.page.evaluate((selector) => {
    const input = document.querySelector<HTMLInputElement>('#e2e-native-file-source');
    const target = document.querySelector<HTMLElement>(selector);
    if (!input?.files || !target) throw new Error('drop fixture is unavailable');
    const transfer = new DataTransfer();
    for (const file of input.files) transfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        dataTransfer: transfer
      }));
    }
    input.remove();
  }, targetSelector);
}

async function listTasks(page: Page, workspaceRoot: string): Promise<any[]> {
  return page.evaluate(async (root) => (
    (window as any).workstation.listClassTasks({ workspaceRoot: root })
  ), workspaceRoot);
}

async function cardStatuses(page: Page): Promise<string[]> {
  return page.locator('.class-task-card .class-task-status').allTextContents();
}

async function waitForTaskStates(
  page: Page,
  workspaceRoot: string,
  expectedStates: string[]
): Promise<void> {
  await expect.poll(async () => (
    (await listTasks(page, workspaceRoot)).map((task) => task.state)
  )).toEqual(expectedStates);
}

async function waitForTaskState(
  page: Page,
  workspaceRoot: string,
  taskIndex: number,
  expectedState: string
): Promise<void> {
  await expect.poll(async () => {
    const task = (await listTasks(page, workspaceRoot))[taskIndex];
    if (expectedState !== 'FAILED' && task?.state === 'FAILED') {
      throw new Error(`Task failed before reaching ${expectedState}: ${JSON.stringify(task.lastError)}`);
    }
    return task?.state;
  }).toBe(expectedState);
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    ))
  );
}

function normalizePath(value: string): string {
  return resolve(value).replaceAll('\\', '/').toLocaleLowerCase();
}

async function visibleArcPosition(segment: Locator): Promise<{ x: number; y: number }> {
  return segment.evaluate((element) => {
    if (!(element instanceof SVGCircleElement) || !element.ownerSVGElement) {
      throw new Error('新增覆盖扇区不是有效的 SVG 圆弧');
    }
    const radius = Number(element.getAttribute('r'));
    const centerX = Number(element.getAttribute('cx'));
    const centerY = Number(element.getAttribute('cy'));
    const percent = Number(element.getAttribute('stroke-dasharray')?.split(/[ ,]/u)[0]);
    const offsetPercent = -Number(element.getAttribute('stroke-dashoffset'));
    if (![radius, centerX, centerY, percent, offsetPercent].every(Number.isFinite)) {
      throw new Error('新增覆盖扇区缺少有效的几何信息');
    }

    const angle = ((offsetPercent + percent / 2) / 100) * Math.PI * 2 - Math.PI / 2;
    const viewBox = element.ownerSVGElement.viewBox.baseVal;
    const bounds = element.ownerSVGElement.getBoundingClientRect();
    if (viewBox.width <= 0 || viewBox.height <= 0 || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error('新增覆盖扇区没有可用的 SVG 视口');
    }
    return {
      x: ((centerX + radius * Math.cos(angle) - viewBox.x) / viewBox.width) * bounds.width,
      y: ((centerY + radius * Math.sin(angle) - viewBox.y) / viewBox.height) * bounds.height
    };
  });
}
