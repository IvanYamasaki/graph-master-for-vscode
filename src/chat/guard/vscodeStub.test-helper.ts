/** Stub mínimo do módulo vscode para os testes do guarda: só getConfiguration, com valores de `testConfig`. */
import { createRequire } from 'node:module';

export const testConfig: Record<string, unknown> = {};

const stub = {
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback?: T): T => (key in testConfig ? (testConfig[key] as T) : (fallback as T)),
    }),
  },
};

// O namespace importado é só leitura; o objeto Module de verdade vem do require.
const M = createRequire(__filename)('module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const original = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? stub : original.call(this, request, ...rest);
};
