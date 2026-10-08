/**
 * Testes da cópia de sessão entre contas. Sem VS Code:
 *   npx esbuild src/chat/transfer.test.ts --bundle --platform=node --outfile=$TEMP/transfer.test.js && node $TEMP/transfer.test.js
 */
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copySession, findSession, targetTranscript } from './transfer';

let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-transfer-'));
const from = { id: 'a', name: 'A', configDir: path.join(root, 'a') };
const to = { id: 'b', name: 'B', configDir: path.join(root, 'b') };
const cwd = 'c:/Users/x/proj';
const id = '11111111-2222-3333-4444-555555555555';
const folder = path.join(from.configDir, 'projects', 'c--Users-x-proj');
fs.mkdirSync(path.join(folder, id, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(folder, `${id}.jsonl`), '{"type":"user"}\n');
fs.writeFileSync(path.join(folder, id, 'subagents', 'agent-1.jsonl'), 'sub\n');
fs.mkdirSync(path.join(from.configDir, 'file-history', id), { recursive: true });
fs.writeFileSync(path.join(from.configDir, 'file-history', id, 'snap@v1'), 'old');
// Sessão de mesmo id em outro projeto não deve ganhar da pasta do cwd.
fs.mkdirSync(path.join(from.configDir, 'projects', 'aaa-outro'), { recursive: true });
fs.writeFileSync(path.join(from.configDir, 'projects', 'aaa-outro', `${id}.jsonl`), 'errado\n');

void (async () => {
  await test('acha a sessão na pasta do cwd, com subagentes e checkpoints', async () => {
    const found = await findSession(from, id, cwd);
    assert.ok(found);
    assert.equal(found.projectFolder, 'c--Users-x-proj');
    assert.equal(found.extras.length, 2);
  });

  await test('sessão inexistente devolve undefined', async () => {
    assert.equal(await findSession(from, 'nada', cwd), undefined);
    assert.equal(await findSession(to, id, cwd), undefined);
  });

  await test('copia tudo para a outra conta e substitui cópia anterior', async () => {
    const found = (await findSession(from, id, cwd))!;
    assert.equal(targetTranscript(to, found).exists, false);
    await copySession(found, from, to);
    assert.equal(targetTranscript(to, found).exists, true);
    assert.equal(fs.readFileSync(path.join(to.configDir, 'projects', 'c--Users-x-proj', id, 'subagents', 'agent-1.jsonl'), 'utf8'), 'sub\n');
    fs.writeFileSync(path.join(to.configDir, 'file-history', id, 'sobra'), 'x');
    fs.appendFileSync(found.transcript, '{"type":"assistant"}\n');
    await copySession(found, from, to);
    assert.equal(fs.readFileSync(targetTranscript(to, found).file, 'utf8'), '{"type":"user"}\n{"type":"assistant"}\n');
    assert.equal(fs.existsSync(path.join(to.configDir, 'file-history', id, 'sobra')), false);
    assert.equal(await findSession(to, id, cwd).then((f) => f?.projectFolder), 'c--Users-x-proj');
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} falharam`);
    process.exit(1);
  }
})();
