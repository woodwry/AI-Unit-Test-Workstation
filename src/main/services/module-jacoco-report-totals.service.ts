import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';

import type { CoverageTotals } from '../../shared/class-task-contracts.ts';

const MAX_JACOCO_REPORT_BYTES = 32 * 1024 * 1024;
const REQUIRED_COUNTER_TYPES = ['INSTRUCTION', 'BRANCH', 'COMPLEXITY', 'LINE'] as const;
const STANDARD_JACOCO_DOCTYPE = /<!DOCTYPE\s+report\s+PUBLIC\s+["']-\/\/JACOCO\/\/DTD Report 1\.1\/\/EN["']\s+["']report\.dtd["']\s*>/i;

export type ModuleJacocoReportTotalsPort = {
  read(moduleRoot: string, qualifiedClassName: string): Promise<CoverageTotals | null>;
  readReport(reportPath: string, qualifiedClassName: string): Promise<CoverageTotals | null>;
};

/** 读取用户模块标准 JaCoCo 报告中目标源码文件的 Total 计数。 */
export class ModuleJacocoReportTotalsService implements ModuleJacocoReportTotalsPort {
  async read(moduleRoot: string, qualifiedClassName: string): Promise<CoverageTotals | null> {
    const reportPath = join(resolve(moduleRoot), 'target', 'site', 'jacoco', 'jacoco.xml');
    return this.readReport(reportPath, qualifiedClassName);
  }

  /** 读取与当前任务 reportPairId 对应的 JaCoCo 报告，避免并发任务串用共享报告。 */
  async readReport(reportPath: string, qualifiedClassName: string): Promise<CoverageTotals | null> {
    const resolvedReportPath = resolve(reportPath);
    let stat;
    try {
      stat = await fs.stat(resolvedReportPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JACOCO_REPORT_BYTES) {
      throw new Error('用户模块 JaCoCo 报告无效。');
    }

    const xml = await fs.readFile(resolvedReportPath, 'utf8');
    const parseableXml = xml.replace(STANDARD_JACOCO_DOCTYPE, '');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(parseableXml)) {
      throw new Error('用户模块 JaCoCo 报告禁止包含 DTD 或实体声明。');
    }
    const parseErrors: string[] = [];
    const document = new DOMParser({
      onError: (_level, message) => parseErrors.push(String(message))
    }).parseFromString(parseableXml, 'application/xml');
    const root = document.documentElement;
    if (parseErrors.length > 0 || !root || root.tagName !== 'report') {
      throw new Error('无法解析用户模块 JaCoCo 报告。');
    }

    const packageName = qualifiedClassName.includes('.')
      ? qualifiedClassName.slice(0, qualifiedClassName.lastIndexOf('.')).replaceAll('.', '/')
      : '';
    let packageElement: XmlElement | null = null;
    for (let child = root.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1 || child.nodeName !== 'package') continue;
      const element = child as XmlElement;
      if (element.getAttribute('name') === packageName) {
        packageElement = element;
        break;
      }
    }
    if (!packageElement) return null;

    const className = qualifiedClassName.replaceAll('.', '/');
    let classElement: XmlElement | null = null;
    for (let child = packageElement.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1 || child.nodeName !== 'class') continue;
      const element = child as XmlElement;
      if (element.getAttribute('name') === className) {
        classElement = element;
        break;
      }
    }
    if (!classElement) return null;

    const coverageElement = sourceFileCoverageElement(packageElement, classElement);
    const counters = new Map<string, { covered: number; missed: number }>();
    for (let child = coverageElement.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1 || child.nodeName !== 'counter') continue;
      const element = child as XmlElement;
      const type = element.getAttribute('type');
      if (!type || !REQUIRED_COUNTER_TYPES.includes(
        type as (typeof REQUIRED_COUNTER_TYPES)[number]
      )) continue;
      counters.set(type, {
        covered: nonNegativeInteger(element.getAttribute('covered') ?? ''),
        missed: nonNegativeInteger(element.getAttribute('missed') ?? '')
      });
    }
    for (const type of REQUIRED_COUNTER_TYPES) {
      if (type !== 'BRANCH' && !counters.has(type)) {
        throw new Error(`JaCoCo 报告缺少 ${type} 总计。`);
      }
    }

    const instruction = counters.get('INSTRUCTION')!;
    const branch = counters.get('BRANCH') ?? { covered: 0, missed: 0 };
    const complexity = counters.get('COMPLEXITY')!;
    const line = counters.get('LINE')!;
    return {
      instructionCovered: instruction.covered,
      instructionMissed: instruction.missed,
      branchCovered: branch.covered,
      branchMissed: branch.missed,
      complexityCovered: complexity.covered,
      complexityMissed: complexity.missed,
      lineCovered: line.covered,
      lineMissed: line.missed
    };
  }
}

function sourceFileCoverageElement(
  packageElement: XmlElement,
  classElement: XmlElement
): XmlElement {
  const sourceFileName = classElement.getAttribute('sourcefilename');
  if (!sourceFileName) return classElement;

  for (let child = packageElement.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1 || child.nodeName !== 'sourcefile') continue;
    const sourceFile = child as XmlElement;
    if (sourceFile.getAttribute('name') !== sourceFileName) continue;
    for (let nested = sourceFile.firstChild; nested; nested = nested.nextSibling) {
      if (nested.nodeType === 1 && nested.nodeName === 'counter') return sourceFile;
    }
  }
  return classElement;
}

function nonNegativeInteger(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error('JaCoCo 报告总计必须是非负整数。');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('JaCoCo 报告总计超出安全整数范围。');
  }
  return parsed;
}
