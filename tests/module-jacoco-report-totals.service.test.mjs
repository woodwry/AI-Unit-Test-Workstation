import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ModuleJacocoReportTotalsService } from '../src/main/services/module-jacoco-report-totals.service.ts';

test('reads the JaCoCo Total counters for the current class', async (context) => {
  const temporaryRoot = join(process.cwd(), '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const moduleRoot = await mkdtemp(join(temporaryRoot, 'module-jacoco-total-'));
  context.after(() => rm(moduleRoot, { recursive: true, force: true }));
  const reportDirectory = join(moduleRoot, 'target', 'site', 'jacoco');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'jacoco.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="fixture">
  <package name="com/dtsz/report/dao/base">
    <class name="com/dtsz/report/dao/base/SSODaoImpl">
      <counter type="INSTRUCTION" missed="4313" covered="46"/>
      <counter type="BRANCH" missed="617" covered="2"/>
      <counter type="COMPLEXITY" missed="406" covered="5"/>
      <counter type="LINE" missed="1081" covered="13"/>
    </class>
    <counter type="INSTRUCTION" missed="14863" covered="228"/>
    <counter type="BRANCH" missed="1827" covered="22"/>
    <counter type="COMPLEXITY" missed="1308" covered="12"/>
    <counter type="LINE" missed="3698" covered="58"/>
  </package>
  <counter type="INSTRUCTION" missed="16478" covered="228"/>
  <counter type="BRANCH" missed="1929" covered="22"/>
  <counter type="COMPLEXITY" missed="1429" covered="12"/>
  <counter type="LINE" missed="4076" covered="58"/>
</report>
`, 'utf8');

  const actual = await new ModuleJacocoReportTotalsService().read(
    moduleRoot,
    'com.dtsz.report.dao.base.SSODaoImpl'
  );

  assert.deepEqual(actual, {
    instructionCovered: 46,
    instructionMissed: 4313,
    branchCovered: 2,
    branchMissed: 617,
    complexityCovered: 5,
    complexityMissed: 406,
    lineCovered: 13,
    lineMissed: 1081
  });
});

test('uses target source-file totals when anonymous classes share its Java file', async (context) => {
  const temporaryRoot = join(process.cwd(), '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const moduleRoot = await mkdtemp(join(temporaryRoot, 'module-jacoco-source-total-'));
  context.after(() => rm(moduleRoot, { recursive: true, force: true }));
  const reportDirectory = join(moduleRoot, 'target', 'site', 'jacoco');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'jacoco.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<report name="fixture">
  <package name="com/example">
    <class name="com/example/Target" sourcefilename="Target.java">
      <counter type="INSTRUCTION" missed="0" covered="82"/>
      <counter type="BRANCH" missed="0" covered="6"/>
      <counter type="COMPLEXITY" missed="0" covered="10"/>
      <counter type="LINE" missed="0" covered="28"/>
    </class>
    <class name="com/example/Target$1" sourcefilename="Target.java">
      <counter type="INSTRUCTION" missed="7" covered="5"/>
      <counter type="BRANCH" missed="5" covered="0"/>
      <counter type="COMPLEXITY" missed="4" covered="1"/>
      <counter type="LINE" missed="7" covered="1"/>
    </class>
    <sourcefile name="Target.java">
      <line nr="10" mi="0" ci="3" mb="0" cb="0"/>
      <counter type="INSTRUCTION" missed="7" covered="87"/>
      <counter type="BRANCH" missed="5" covered="5"/>
      <counter type="COMPLEXITY" missed="4" covered="11"/>
      <counter type="LINE" missed="7" covered="27"/>
    </sourcefile>
  </package>
</report>
`, 'utf8');

  assert.deepEqual(await new ModuleJacocoReportTotalsService().read(
    moduleRoot,
    'com.example.Target'
  ), {
    instructionCovered: 87,
    instructionMissed: 7,
    branchCovered: 5,
    branchMissed: 5,
    complexityCovered: 11,
    complexityMissed: 4,
    lineCovered: 27,
    lineMissed: 7
  });
});

test('reads a task-scoped JaCoCo report directly instead of the shared module report', async (context) => {
  const temporaryRoot = join(process.cwd(), '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const moduleRoot = await mkdtemp(join(temporaryRoot, 'task-jacoco-total-'));
  context.after(() => rm(moduleRoot, { recursive: true, force: true }));
  const taskReportPath = join(moduleRoot, 'target', 'ai-unit-test', 'jacoco', 'tasks', 'task', 'current.xml');
  await mkdir(dirname(taskReportPath), { recursive: true });
  await writeFile(taskReportPath, `<?xml version="1.0" encoding="UTF-8"?>
<report name="task-current">
  <package name="com/example">
    <class name="com/example/Target" sourcefilename="Target.java">
      <counter type="INSTRUCTION" missed="12" covered="88"/>
      <counter type="BRANCH" missed="3" covered="7"/>
      <counter type="COMPLEXITY" missed="4" covered="6"/>
      <counter type="LINE" missed="8" covered="32"/>
    </class>
    <sourcefile name="Target.java">
      <counter type="INSTRUCTION" missed="12" covered="88"/>
      <counter type="BRANCH" missed="3" covered="7"/>
      <counter type="COMPLEXITY" missed="4" covered="6"/>
      <counter type="LINE" missed="8" covered="32"/>
    </sourcefile>
  </package>
</report>
`, 'utf8');

  assert.deepEqual(await new ModuleJacocoReportTotalsService().readReport(
    taskReportPath,
    'com.example.Target'
  ), {
    instructionCovered: 88,
    instructionMissed: 12,
    branchCovered: 7,
    branchMissed: 3,
    complexityCovered: 6,
    complexityMissed: 4,
    lineCovered: 32,
    lineMissed: 8
  });
});
test('falls back when the module has no standard JaCoCo report', async (context) => {
  const temporaryRoot = join(process.cwd(), '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const moduleRoot = await mkdtemp(join(temporaryRoot, 'module-without-jacoco-'));
  context.after(() => rm(moduleRoot, { recursive: true, force: true }));

  assert.equal(await new ModuleJacocoReportTotalsService().read(
    moduleRoot,
    'example.Target'
  ), null);
});

test('treats an omitted BRANCH counter as a class with no branches', async (context) => {
  const temporaryRoot = join(process.cwd(), '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const moduleRoot = await mkdtemp(join(temporaryRoot, 'module-jacoco-no-branches-'));
  context.after(() => rm(moduleRoot, { recursive: true, force: true }));
  const reportDirectory = join(moduleRoot, 'target', 'site', 'jacoco');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'jacoco.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<report name="fixture">
  <package name="com/example">
    <class name="com/example/BorderVO">
      <counter type="INSTRUCTION" missed="24" covered="0"/>
      <counter type="COMPLEXITY" missed="9" covered="0"/>
      <counter type="LINE" missed="6" covered="0"/>
    </class>
  </package>
</report>
`, 'utf8');

  assert.deepEqual(await new ModuleJacocoReportTotalsService().read(
    moduleRoot,
    'com.example.BorderVO'
  ), {
    instructionCovered: 0,
    instructionMissed: 24,
    branchCovered: 0,
    branchMissed: 0,
    complexityCovered: 0,
    complexityMissed: 9,
    lineCovered: 0,
    lineMissed: 6
  });
});
