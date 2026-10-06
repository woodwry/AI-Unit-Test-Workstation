import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CommandResult } from '../../shared/types.ts';

const PACKAGE_PATH = 'aiunittest/runtime';
const EXTENSION = 'aiunittest.runtime.MethodWatchdog';
const SERVICE_PATH = 'META-INF/services/org.junit.jupiter.api.extension.Extension';

// Compile against the stable Jupiter interceptor ABI without resolving new
// project dependencies. The ABI declarations are never installed at runtime;
// the project's own JUnit supplies those classes to the generated extension.
const SOURCES: Record<string, string> = {
  'org/junit/jupiter/api/extension/Extension.java': `package org.junit.jupiter.api.extension; public interface Extension {}`,
  'org/junit/jupiter/api/extension/ExtensionContext.java': `package org.junit.jupiter.api.extension; public interface ExtensionContext {}`,
  'org/junit/jupiter/api/extension/ReflectiveInvocationContext.java': `package org.junit.jupiter.api.extension;
public interface ReflectiveInvocationContext<T extends java.lang.reflect.Executable> { T getExecutable(); }`,
  'org/junit/jupiter/api/extension/InvocationInterceptor.java': `package org.junit.jupiter.api.extension;
public interface InvocationInterceptor extends Extension {
  interface Invocation<T> { T proceed() throws Throwable; }
  void interceptTestMethod(Invocation<Void> i, ReflectiveInvocationContext<java.lang.reflect.Method> c, ExtensionContext e) throws Throwable;
  void interceptTestTemplateMethod(Invocation<Void> i, ReflectiveInvocationContext<java.lang.reflect.Method> c, ExtensionContext e) throws Throwable;
}`,
  [`${PACKAGE_PATH}/MethodWatchdog.java`]: `package aiunittest.runtime;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.extension.*;

/** Preserves lifecycle/Mockito thread affinity; only kills an unresponsive method. */
public final class MethodWatchdog implements InvocationInterceptor {
  private static final ScheduledExecutorService TIMER = Executors.newScheduledThreadPool(1, r -> {
    Thread t = new Thread(r, "ai-unit-test-method-watchdog"); t.setDaemon(true); return t;
  });
  public void interceptTestMethod(Invocation<Void> i, ReflectiveInvocationContext<Method> c, ExtensionContext e) throws Throwable { run(i, c); }
  public void interceptTestTemplateMethod(Invocation<Void> i, ReflectiveInvocationContext<Method> c, ExtensionContext e) throws Throwable { run(i, c); }
  private void run(Invocation<Void> invocation, ReflectiveInvocationContext<Method> context) throws Throwable {
    long seconds = Long.getLong("ai.unit.test.method.watchdog.seconds", 0L);
    if (seconds <= 0) { invocation.proceed(); return; }
    Method method = context.getExecutable();
    Object lock = new Object();
    boolean[] finished = {false};
    // Allow Jupiter's same-thread interrupt timeout to finish and write its XML.
    // If the method ignores interruption, record its actual identity and stop
    // this Surefire fork. The caller deletes that method and revalidates others.
    ScheduledFuture<?> timeout = TIMER.schedule(() -> {
      synchronized (lock) {
        if (finished[0]) return;
        String owner = method.getDeclaringClass().getName(), name = method.getName();
        String reason = "Test method exceeded " + seconds + " seconds and did not finish after interruption (method watchdog).";
        String xml = "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n"
          + "<testsuite name=\\"" + owner + "\\" tests=\\"1\\" failures=\\"0\\" errors=\\"1\\" skipped=\\"0\\" producer=\\"ai-unit-test-method-watchdog\\">"
          + "<testcase classname=\\"" + owner + "\\" name=\\"" + name + "\\"><error type=\\"java.util.concurrent.TimeoutException\\" message=\\"" + reason + "\\">"
          + "java.util.concurrent.TimeoutException: " + reason + "\\n    at " + owner + "." + name + "(" + method.getDeclaringClass().getSimpleName() + ".java)"
          + "</error></testcase></testsuite>";
        try {
          Path directory = Paths.get(System.getProperty("ai.unit.test.method.watchdog.reports"));
          Files.createDirectories(directory);
          Path pending = directory.resolve("watchdog-" + java.util.UUID.randomUUID() + ".tmp");
          Files.write(pending, xml.getBytes(StandardCharsets.UTF_8));
          Files.move(pending, directory.resolve("TEST-ai-method-timeout-" + owner + ".xml"), StandardCopyOption.REPLACE_EXISTING);
        } catch (Throwable failure) { failure.printStackTrace(System.err); }
        System.err.println("java.util.concurrent.TimeoutException: " + reason);
        System.err.println("    at " + owner + "." + name + "(" + method.getDeclaringClass().getSimpleName() + ".java)");
        System.err.flush();
        Runtime.getRuntime().halt(124);
      }
    }, seconds + 3, TimeUnit.SECONDS);
    try { invocation.proceed(); }
    finally { synchronized (lock) { finished[0] = true; timeout.cancel(false); } }
  }
}`
};

const SOURCE_HASH = createHash('sha256').update(JSON.stringify(SOURCES)).digest('hex');

/** Installs only compiled runtime support under target; never changes test source. */
export class GeneratedTestWatchdogService {
  async install(
    moduleRoot: string,
    compile: (sources: string[], outputDirectory: string) => Promise<CommandResult>,
    signal?: AbortSignal
  ): Promise<CommandResult | null> {
    signal?.throwIfAborted();
    const root = resolve(moduleRoot);
    const runtime = join(root, 'target', 'ai-unit-test', 'runtime', `method-watchdog-${SOURCE_HASH}`);
    const output = join(runtime, 'classes');
    await safeDirectory(root, output);
    const compiled = join(output, PACKAGE_PATH, 'MethodWatchdog.class');
    if (!await exists(compiled)) {
      const paths: string[] = [];
      for (const [name, source] of Object.entries(SOURCES)) {
        signal?.throwIfAborted();
        const path = join(runtime, 'src', name);
        await safeDirectory(root, dirname(path));
        await safeFile(path);
        await fs.writeFile(path, source, 'utf8');
        paths.push(path);
      }
      const result = await compile(paths, output);
      if (result.exitCode !== 0) return result;
    }
    signal?.throwIfAborted();
    const destination = join(root, 'target', 'test-classes');
    await safeDirectory(root, join(destination, PACKAGE_PATH));
    for (const name of await fs.readdir(join(output, PACKAGE_PATH))) {
      if (!/^MethodWatchdog(?:\$[\w$]+)?\.class$/u.test(name)) continue;
      const path = join(destination, PACKAGE_PATH, name);
      await safeFile(path);
      await fs.copyFile(join(output, PACKAGE_PATH, name), path);
    }
    const service = join(destination, SERVICE_PATH);
    await safeDirectory(root, dirname(service));
    await safeFile(service);
    const current = await fs.readFile(service, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (!current.split(/\r?\n/u).some(line => line.trim() === EXTENSION)) {
      await fs.writeFile(service, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${EXTENSION}\n`, 'utf8');
    }
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await safeFile(path); await fs.access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function safeFile(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generated test runtime output must be a regular file.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function safeDirectory(root: string, path: string): Promise<void> {
  const part = relative(root, path);
  if (!part || part.startsWith(`..${sep}`) || part === '..') throw new Error('Generated test runtime directory is outside its module.');
  let cursor = root;
  for (const segment of part.split(sep)) {
    cursor = join(cursor, segment);
    try {
      await fs.mkdir(cursor);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Generated test runtime directory contains a link or invalid directory.');
  }
}
