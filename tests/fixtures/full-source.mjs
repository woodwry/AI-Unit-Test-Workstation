import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function fullSourceFacts(count = 30) {
  return {
    factsId: hash('facts'), reportPairId: hash('report'), sourceSha256: hash('source'),
    declaringType: 'example.Target',
    methods: Array.from({ length: count }, (_, i) => ({
      methodId: hash(`method-${i}`), declaringType: 'example.Target', methodName: `work${i}`,
      descriptor: '()V', modifiers: ['public'], completeMethodSource: `public void work${i}() { /* ${i} */ }`,
      parameterTypes: [], returnType: 'void', declaredExceptions: [], dependencyCalls: [],
      testMethodNamePrefix: `m${i + 1}_`, invocationPlan: {
        strategy: 'DIRECT', receiverExpression: 'target', reflectionMethodName: '',
        parameterClassLiterals: [], staticMethod: false, returnType: 'void',
        declaredExceptions: [], chineseInstruction: '直接调用'
      }
    })),
    targetFixturePlan: {
      targetClass: 'example.Target', targetVariableName: 'target', targetClassDeclaration: 'class Target {}',
      dependencySourceDeclarations: [], constructionMode: 'DIRECT_CONSTRUCTOR',
      constructorParameterTypes: [], constructorArgumentFixtureIds: [], dependencies: [],
      setupStatements: [], status: 'READY', chineseInstruction: '创建真实对象'
    }, referencedTypes: [], necessaryImports: ['import org.junit.jupiter.api.Test;'], warnings: []
  };
}
export function fullSourceBatch(count = 30) {
  const facts = fullSourceFacts(count);
  return { kind: 'full_source', contractVersion: 1, batchId: facts.factsId,
    methodId: facts.methods[0].methodId, facts,
    skillProfileId: 'spring-boot-test-patterns-unit-v1', skillRulesSha256: 'a'.repeat(64) };
}
