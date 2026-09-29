/**
 * Testes do cérebro compartilhado. Sem framework, sem VS Code e sem modelo:
 *   npx esbuild src/chat/brain/brain.test.ts --bundle --platform=node --outfile=$TEMP/brain.test.js && node $TEMP/brain.test.js
 * Com o argumento "child <pasta> <n>", o mesmo arquivo vira um processo que escreve n entradas (teste da trava entre janelas).
 */
import * as assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrainNews, digest, type NewsDelivery, type NewsMode } from './news';
import { BrainStore, BrainError, ENTRY_MAX_CHARS, INDEX_MAX_CHARS, NOTE_WARN_CHARS, findExternalMaps } from './store';

if (process.argv[2] === 'child') {
  const store = new BrainStore(process.argv[3], 'conv-x');
  const n = Number(process.argv[4]);
  void Promise.all(Array.from({ length: n }, (_, i) => store.write({ note: 'temas/entre-janelas', content: `processo ${process.pid} entrada ${i}`, author: `p${process.pid}` }))).then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
} else {
  void main();
}

async function main(): Promise<void> {
  let failed = 0;
  const test = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${err instanceof Error ? err.stack : String(err)}`);
    }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-brain-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1;\n');
  const store = new BrainStore(root, 'conv-1');
  const dir = store.dir;
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const facts = () => (fs.existsSync(path.join(dir, 'fatos')) ? fs.readdirSync(path.join(dir, 'fatos')).sort() : []);
  const markers = (rel: string) => [...read(rel).matchAll(/<!-- (e\d+) \|/g)].map((m) => m[1]);

  /** Todo link relativo em todas as notas (inclusive ESTADO.md e COMO_USAR.md) aponta para um arquivo que existe. */
  const brokenLinks = (): string[] => {
    const broken: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (e.name.endsWith('.md')) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/\]\(([^)\s#<>]+)(#[^)]*)?\)/g)) {
            if (/^[a-z]+:/i.test(m[1])) {
              continue;
            }
            const dest = path.resolve(path.dirname(p), decodeURI(m[1]));
            if (!fs.existsSync(dest)) {
              broken.push(`${path.relative(dir, p)} -> ${m[1]}`);
            }
          }
        }
      }
    };
    walk(dir);
    return broken;
  };

  await test('ensure cria notas base, COMO_USAR e índice, e não recria', async () => {
    assert.equal(store.exists(), false);
    assert.equal(await store.ensure('Projeto Teste'), true);
    for (const f of ['index.md', 'projeto.md', 'glossario.md', 'COMO_USAR.md']) {
      assert.ok(fs.existsSync(path.join(dir, f)), f);
    }
    assert.match(read('index.md'), /# Cérebro compartilhado: Projeto Teste/);
    assert.match(read('index.md'), /\[COMO_USAR\.md\]\(COMO_USAR\.md\)/);
    assert.match(read('COMO_USAR.md'), /Uma ideia por nota/);
    assert.equal(await store.ensure('Outro'), false);
    assert.match(read('index.md'), /Projeto Teste/);
  });

  await test('frente e agentes: fichas, links cruzados, ESTADO.md e índice', async () => {
    await store.upsertFront({ boxId: 'b1', name: 'Onda 1 · fundação', description: 'Base do sistema' });
    await store.upsertAgent({ id: 'a1', description: 'Mapear o webview', task: 'Leia src/webview e resuma', model: 'haiku', boxId: 'b1', status: 'running', account: 'Pessoal' });
    await store.upsertAgent({ id: 'a2', description: 'Revisar o hub', model: 'opus', boxId: 'b1', status: 'running', reportTo: 'main' });
    const front = read('frentes/onda-1-fundacao.md');
    assert.match(front, /\[a1 · Mapear o webview\]\(\.\.\/agentes\/a1-mapear-o-webview\.md\): rodando · haiku/);
    assert.match(front, /em andamento \(2 de 2 rodando\)/);
    assert.match(front, /\[ESTADO\.md\]\(onda-1-fundacao\/ESTADO\.md\)/);
    const state = read('frentes/onda-1-fundacao/ESTADO.md');
    assert.match(state, /## Pendente\n\n- \[a1 · Mapear o webview\]\(\.\.\/\.\.\/agentes\/a1-mapear-o-webview\.md\): rodando/);
    const a1 = read('agentes/a1-mapear-o-webview.md');
    assert.match(a1, /Frente: \[Onda 1 · fundação\]\(\.\.\/frentes\/onda-1-fundacao\.md\)/);
    assert.match(a1, /conta Pessoal · haiku/);
    assert.match(a1, /\[Índice do cérebro\]\(\.\.\/index\.md\)/);
    const idx = read('index.md');
    assert.match(idx, /\[Onda 1 · fundação\]\(frentes\/onda-1-fundacao\.md\) · em andamento .* · \[estado\]\(frentes\/onda-1-fundacao\/ESTADO\.md\)/);
    assert.match(idx, /\[a2 · Revisar o hub\]\(agentes\/a2-revisar-o-hub\.md\)/);
    await store.upsertAgent({ id: 'a1', description: 'Mapear o webview', status: 'completed' });
    assert.match(read('agentes/a1-mapear-o-webview.md'), /conta Pessoal · haiku/);
    assert.match(read('agentes/a1-mapear-o-webview.md'), /Estado: concluído/);
    assert.deepEqual(brokenLinks(), []);
  });

  await test('fato: frontmatter no formato do usuário, confiança e nome do arquivo', async () => {
    const r = await store.fact({
      title: 'O webview só carrega scripts com nonce',
      body: 'Script inline sem nonce é bloqueado pela CSP. Ver [[temas/csp]].',
      whyItMatters: 'Sem saber, o botão novo não responde e não há erro visível.',
      howToApply: 'Gere o nonce no host e passe no HTML.',
      kind: 'regra',
      area: ['Webview', 'CSP'],
      origin: 'src/app.ts:1',
      links: ['frentes/onda-1-fundacao'],
      author: 'a1',
    });
    assert.match(r.rel, /^fatos\/\d{4}-\d{2}-\d{2}-o-webview-so-carrega-scripts-com-nonce\.md$/);
    const t = read(r.rel);
    assert.match(t, /^---\ndata: \d{4}-\d{2}-\d{2}\ntipo: regra\narea: \[webview, csp\]\nagente: a1\nstatus: vigente\nconfianca: confirmado\norigem: "src\/app\.ts:1"\nfrente: b1\n/);
    assert.match(t, /relacionadas: \["\[\[frentes\/onda-1-fundacao\]\]"\]/);
    assert.match(t, /\n# O webview só carrega scripts com nonce\n/);
    assert.match(t, /\*\*Por que importa:\*\* Sem saber/);
    assert.match(t, /\*\*Como aplicar:\*\* Gere o nonce/);
    assert.match(t, /\*\*Evidência:\*\* \[src\/app\.ts:1\]\(\.\.\/\.\.\/\.\.\/src\/app\.ts#L1\) \(confiança: confirmado\)/);
    assert.match(t, /\[Csp\]\(\.\.\/temas\/csp\.md\)/);
    // Sem origem, "confirmado" cai para "inferido", com aviso.
    const r2 = await store.fact({ title: 'O hub serializa as escritas', confidence: 'confirmado', author: 'a2' });
    assert.match(read(r2.rel), /confianca: inferido/);
    assert.ok(r2.warnings.some((w) => /inferido/.test(w)));
    // Mesmo título no mesmo dia: arquivo novo com sufixo, sem sobrescrever.
    const r3 = await store.fact({ title: 'O hub serializa as escritas', author: 'a2' });
    assert.notEqual(r3.rel, r2.rel);
    assert.match(r3.rel, /-2\.md$/);
    // Fato aparece na frente (ficha e índice) e no ESTADO quando é pergunta.
    await store.fact({ title: 'Quem limpa os worktrees descartados?', kind: 'pergunta', author: 'a1' });
    assert.match(read('frentes/onda-1-fundacao.md'), /- Fatos: .*O webview só carrega scripts com nonce/);
    assert.match(read('frentes/onda-1-fundacao/ESTADO.md'), /Pergunta aberta: \[Quem limpa os worktrees descartados\?\]/);
    const idx = read('index.md');
    assert.match(idx, /## Fatos vigentes \(3\)/);
    assert.match(idx, /- \[O webview só carrega scripts com nonce\]\(fatos\/.*\.md\) — regra · confirmado · webview, csp · a1 · \d{4}-\d{2}-\d{2}/);
    assert.match(idx, /## Hipóteses e perguntas abertas \(1\)/);
    assert.deepEqual(brokenLinks(), []);
  });

  await test('fato superado: o antigo vira "superada" com link, nada é apagado', async () => {
    const old = facts().find((f) => f.includes('o-hub-serializa-as-escritas.md'))!;
    const r = await store.fact({ title: 'O hub serializa as escritas por pasta e por trava entre janelas', origin: 'src/app.ts:1', supersedes: `fatos/${old}`, author: 'a2' });
    const t = read(`fatos/${old}`);
    assert.match(t, /status: superada/);
    assert.match(t, new RegExp(`superada_por: ${r.rel.replace(/[.]/g, '\\.')}`));
    assert.match(t, /\*\*Superada por:\*\* \[O hub serializa as escritas por pasta/);
    assert.match(read(r.rel), /\*\*Relacionadas:\*\* \[O hub serializa as escritas\]/);
    assert.match(read('index.md'), /## Superados \(1\)/);
  });

  await test('brain_write em "achados"/"decisoes" vira nota de fato (nome antigo continua valendo)', async () => {
    const before = facts().length;
    const r = await store.write({ note: 'decisões', content: 'Usar uma nota por fato\nPorque a busca por um fato não traz ruído de outro.', origin: 'src/app.ts:1', author: 'a2' });
    assert.equal(facts().length, before + 1);
    assert.match(r.rel, /^fatos\/.*usar-uma-nota-por-fato\.md$/);
    assert.match(read(r.rel), /tipo: decisao/);
    assert.ok(r.warnings.some((w) => /brain_fact/.test(w)));
    await assert.rejects(store.write({ note: r.rel, content: 'mais uma linha', author: 'a1' }), /nota de fato/);
  });

  await test('nota escrita à mão no formato do usuário é lida e aparece no índice', async () => {
    fs.writeFileSync(
      path.join(dir, 'fatos', '2026-05-06-um-contato-tem-uma-deal-aberta.md'),
      '---\ndata: 2026-05-06\ntipo: regra\narea: [crm, dedup]\nrepos: [revops]\nstatus: vigente\norigem: Notion, documentação revops\n---\n\n# Um contato tem uma deal aberta\n\nTexto.\n\n**Por quê importa:** algo.\n',
    );
    await store.upsertAgent({ id: 'a2', description: 'Revisar o hub', status: 'running' });
    assert.match(read('index.md'), /\[Um contato tem uma deal aberta\]\(fatos\/2026-05-06-um-contato-tem-uma-deal-aberta\.md\) — regra · confirmado · crm, dedup · usuário · 2026-05-06/);
    assert.ok(store.search('dedup crm').some((h) => /um-contato-tem-uma-deal-aberta/.test(h.rel)));
  });

  await test('10 escritas simultâneas em 3 notas e 10 fatos simultâneos: nada perdido, ids únicos', async () => {
    const notes = ['projeto', 'glossario', 'temas/arquitetura-do-webview'];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.write({
          note: notes[i % 3],
          content: `entrada concorrente ${i} sobre CSP do webview`,
          author: i % 2 ? 'a1' : 'a2',
          links: i === 0 ? ['temas/arquitetura-do-webview', 'glossario'] : undefined,
          origin: i === 1 ? 'src/app.ts:1' : undefined,
        }),
      ),
    );
    for (let i = 0; i < 10; i++) {
      assert.match(read(results[i].rel), new RegExp(`entrada concorrente ${i} sobre`), `entrada ${i} em ${results[i].rel}`);
    }
    assert.equal(markers('projeto.md').length, 4);
    assert.equal(new Set(markers('projeto.md')).size, 4);
    assert.equal(markers('glossario.md').length, 3);
    assert.equal(markers('temas/arquitetura-do-webview.md').length, 3);
    for (const rel of ['projeto.md', 'glossario.md', 'temas/arquitetura-do-webview.md']) {
      const t = read(rel);
      assert.equal(t.match(/<!-- brain:ficha /g)?.length, 1, rel);
      assert.equal(t.match(/^# /gm)?.length, 1, rel);
      assert.ok((t.match(/## Mencionado em/g)?.length ?? 0) <= 1, rel);
    }
    const before = facts().length;
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => store.fact({ title: `Fato paralelo número ${i}`, area: ['carga'], author: `a${i % 3}` })));
    assert.equal(new Set(made.map((m) => m.rel)).size, 10);
    assert.equal(facts().length, before + 10);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'sobrou temporário ou trava');
  });

  await test('links de volta: "Mencionado em" nas notas de destino e do autor', async () => {
    assert.match(read('temas/arquitetura-do-webview.md'), /## Mencionado em[\s\S]*\[O projeto\]\(\.\.\/projeto\.md\)/);
    assert.match(read('glossario.md'), /## Mencionado em[\s\S]*\[O projeto\]\(projeto\.md\)/);
    assert.match(read('projeto.md'), /\[a2\]\(agentes\/a2-revisar-o-hub\.md\)/);
    assert.match(read('agentes/a2-revisar-o-hub.md'), /## Mencionado em[\s\S]*\[O projeto\]\(\.\.\/projeto\.md\)/);
    assert.match(read('glossario.md'), /\[src\/app\.ts:1\]\(\.\.\/\.\.\/src\/app\.ts#L1\)/);
    // O fato que liga a frente aparece no "Mencionado em" dela.
    assert.match(read('frentes/onda-1-fundacao.md'), /## Mencionado em[\s\S]*O webview só carrega scripts com nonce/);
    assert.deepEqual(brokenLinks(), []);
  });

  await test('[[wiki]] vira link relativo e cria o tema', async () => {
    await store.write({ note: 'projeto', content: 'Ver [[temas/csp]] e [[glossário|o glossário]].', author: 'a1' });
    const a = read('projeto.md');
    assert.match(a, /\[Csp\]\(temas\/csp\.md\)/);
    assert.match(a, /\[o glossário\]\(glossario\.md\)/);
    assert.deepEqual(brokenLinks(), []);
  });

  await test('índice: uma linha por fato, curto mesmo com muita coisa', async () => {
    const idx = read('index.md');
    assert.match(idx, /## Últimas atualizações\n\n- /);
    for (let i = 0; i < 60; i++) {
      await store.upsertAgent({ id: `a${100 + i}`, description: `agente de carga número ${i} com descrição comprida para encher o índice`, boxId: 'b1', status: 'completed' });
    }
    await Promise.all(Array.from({ length: 80 }, (_, i) => store.fact({ title: `Fato de carga ${i} com um título razoavelmente comprido para ocupar a linha`, area: ['carga', 'indice'], author: 'a1' })));
    const big = read('index.md');
    assert.ok(big.length <= INDEX_MAX_CHARS, `índice com ${big.length}`);
    assert.match(big, /e mais \d+ \(use brain_search\)/);
  });

  await test('busca: acento, caixa, termo curto, trechos com nota e autor', () => {
    const hits = store.search('CSP WEBVIEW concorrente 7');
    assert.ok(hits.length >= 1);
    assert.match(hits[0].snippet, /entrada concorrente 7/);
    assert.equal(hits[0].author, 'a1');
    assert.ok(store.search('nonce').some((h) => /o-webview-so-carrega/.test(h.rel) && h.author === 'a1'));
    assert.deepEqual(store.search('palavraquenaoexiste'), []);
    assert.ok(store.search('fundacao').some((h) => h.rel === 'frentes/onda-1-fundacao.md'));
    assert.ok(store.search('armadilha regra').length >= 0);
  });

  await test('leitura: índice sem nota, nota por nome curto, fato sem a data, paginação e aviso de tamanho', async () => {
    const idx = store.read();
    assert.ok(!(idx instanceof BrainError) && idx.rel === 'index.md');
    const a2 = store.read('a2');
    assert.ok(!(a2 instanceof BrainError) && a2.rel === 'agentes/a2-revisar-o-hub.md');
    const b1 = store.read('b1');
    assert.ok(!(b1 instanceof BrainError) && b1.rel === 'frentes/onda-1-fundacao.md');
    const f = store.read('o-webview-so-carrega-scripts-com-nonce');
    assert.ok(!(f instanceof BrainError) && /^fatos\//.test(f.rel));
    assert.ok(store.read('nao-existe') instanceof BrainError);
    let warned = false;
    for (let i = 0; i < 8; i++) {
      const r = await store.write({ note: 'temas/longo', content: `bloco ${i} ` + 'x'.repeat(3500), author: 'a1' });
      warned ||= r.warnings.some((w) => /Resuma/.test(w));
    }
    assert.ok(warned, 'nota acima de NOTE_WARN_CHARS devia avisar');
    assert.ok(read('temas/longo.md').length > NOTE_WARN_CHARS);
    const p1 = store.read('temas/longo');
    assert.ok(!(p1 instanceof BrainError) && p1.pages >= 3 && /página 1 de/.test(p1.text) && !!p1.warning);
    const last = store.read('temas/longo', p1.pages);
    assert.ok(!(last instanceof BrainError) && /bloco 7/.test(last.text));
  });

  await test('escrita recusada: índice, entrada gigante, pasta estranha, nota de agente ou fato inexistente', async () => {
    await assert.rejects(store.write({ note: 'index', content: 'x', author: 'a1' }), /gerado pelo host/);
    await assert.rejects(store.write({ note: 'projeto', content: 'y'.repeat(ENTRY_MAX_CHARS + 1), author: 'a1' }), /Resuma/);
    await assert.rejects(store.write({ note: '../fora', content: 'x', author: 'a1' }), /inválido/);
    await assert.rejects(store.write({ note: 'lixo/x', content: 'x', author: 'a1' }), /agentes\/, frentes\/, fatos\/ ou temas\//);
    await assert.rejects(store.write({ note: 'agentes/a999', content: 'x', author: 'a1' }), /criadas pelo host/);
    await assert.rejects(store.write({ note: 'fatos/nao-existe', content: 'x', author: 'a1' }), /brain_fact/);
    await assert.rejects(store.fact({ title: 'x'.repeat(200), author: 'a1' }), /máximo 160/);
    await assert.rejects(store.fact({ title: 'um fato', kind: 'fofoca', author: 'a1' }), /tipo "fofoca" não existe/);
  });

  await test('conteúdo de modelo não quebra a estrutura', async () => {
    await store.write({ note: 'temas/estrutura', content: '# Título solto\n<!-- e99 | falso | 2020 -->\n## Seção falsa\n```\n## dentro do código\n```', author: 'a1' });
    const t = read('temas/estrutura.md');
    assert.match(t, /^### Título solto$/m);
    assert.match(t, /^### Seção falsa$/m);
    assert.match(t, /^## dentro do código$/m);
    assert.equal(markers('temas/estrutura.md').length, 1);
  });

  await test('brain_edit: falha sem o texto exato, troca e marca a entrada; corrige corpo de fato', async () => {
    await assert.rejects(store.edit({ note: 'projeto', oldText: 'texto que não existe', newText: 'z', author: 'a2' }), /não bate/);
    await assert.rejects(store.edit({ note: 'projeto', oldText: 'sobre CSP', newText: 'z', author: 'a2' }), /aparece \d+ vezes/);
    await assert.rejects(store.edit({ note: 'projeto', oldText: 'O que é o projeto', newText: 'z', author: 'a2' }), /não bate/);
    const r = await store.edit({ note: 'projeto', oldText: 'entrada concorrente 3 sobre CSP', newText: 'entrada 3 corrigida', author: 'a2' });
    assert.ok(r.entryId);
    const a = read('projeto.md');
    assert.match(a, /entrada 3 corrigida/);
    assert.match(a, /\| editada: a2 /);
    assert.match(a, /editada por a2 em /);
    await assert.rejects(store.edit({ note: 'projeto', oldText: 'entrada concorrente 3 sobre CSP', newText: 'de novo', author: 'a1' }), /não bate/);
    await store.edit({ note: 'o-webview-so-carrega-scripts-com-nonce', oldText: 'Gere o nonce no host', newText: 'Gere o nonce por carga do painel', author: 'a2' });
    const f = read(facts().find((x) => x.includes('o-webview-so-carrega'))!.replace(/^/, 'fatos/'));
    assert.match(f, /Gere o nonce por carga do painel/);
    assert.match(f, /^---\ndata: /);
  });

  await test('relatório e veredito: resumo na nota do agente, ESTADO "feito", veredito vira fato', async () => {
    const report = 'Conclusão: o webview usa CSP estrita.\n\n' + Array.from({ length: 30 }, (_, i) => `linha ${i}`).join('\n');
    await store.recordReport('a1', { to: 'main', text: report, files: ['src/webview/main.ts', 'src/chat/hub.ts'], status: 'completed' });
    const a1 = read('agentes/a1-mapear-o-webview.md');
    assert.match(a1, /## Relatórios[\s\S]*Relatório entregue a main/);
    assert.match(a1, /> Conclusão: o webview usa CSP estrita\./);
    assert.match(a1, /continua no mapa de agentes/);
    assert.match(a1, /Arquivos alterados: `src\/webview\/main\.ts`/);
    assert.match(a1, /último entregue a main em/);
    assert.match(read('frentes/onda-1-fundacao/ESTADO.md'), /## Feito\n\n- \[a1 · Mapear o webview\]\(.*\): Conclusão: o webview usa CSP estrita\./);
    assert.equal(await store.recordReport('a404', { to: 'main', text: 'x' }), undefined);
    fs.mkdirSync(path.join(root, '.agm', 'lab'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agm', 'lab', 'hypotheses.jsonl'), '{}\n');
    const v = await store.recordVerdict({ hypothesisId: 'h3', title: 'Cache ajuda', verdict: 'suportada', by: 'a2' });
    const t = read(v.rel);
    assert.match(t, /tipo: achado/);
    assert.match(t, /confianca: confirmado/);
    assert.match(t, /# Hipótese h3 \(Cache ajuda\): suportada/);
    assert.match(t, /\[\.agm\/lab\/hypotheses\.jsonl\]\(\.\.\/\.\.\/lab\/hypotheses\.jsonl\)/);
    assert.deepEqual(brokenLinks(), []);
  });

  await test('ids repetidos em outra conversa não colidem', async () => {
    const other = new BrainStore(root, 'conv-2');
    await other.upsertAgent({ id: 'a1', description: 'Mapear o webview', boxId: 'b1', status: 'running' });
    assert.ok(fs.existsSync(path.join(dir, 'agentes', 'a1-mapear-o-webview-2.md')));
    assert.equal(path.basename(store.agentNotePath('a1')!), 'a1-mapear-o-webview.md');
    assert.equal(path.basename(other.agentNotePath('a1')!), 'a1-mapear-o-webview-2.md');
  });

  await test('duas instâncias e dois processos escrevendo juntos: trava entre janelas', async () => {
    const twin = new BrainStore(root, 'conv-1');
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => store.write({ note: 'temas/entre-janelas', content: `instância A ${i}`, author: 'a1' })),
      ...Array.from({ length: 5 }, (_, i) => twin.write({ note: 'temas/entre-janelas', content: `instância B ${i}`, author: 'a2' })),
    ]);
    const self = process.argv[1];
    await Promise.all(
      [0, 1].map(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [self, 'child', root, '6'], { stdio: 'inherit' });
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`filho saiu com ${code}`))));
          }),
      ),
    );
    const ids = markers('temas/entre-janelas.md');
    assert.equal(ids.length, 22);
    assert.equal(new Set(ids).size, 22);
    assert.equal(read('temas/entre-janelas.md').match(/<!-- brain:ficha /g)?.length, 1);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  });

  await test('avisos: 4 escritas viram UM resumo por destinatário, sem o autor; parado recebe na próxima mensagem', async () => {
    const pushed: { id: string; text: string }[] = [];
    const delivered: NewsDelivery[] = [];
    const busy = new Set(['a2', 'main']);
    let mode: NewsMode = 'all';
    const news = new BrainNews({
      recipients: () => [{ id: 'main' }, { id: 'a1', boxId: 'b1' }, { id: 'a2', boxId: 'b2' }, { id: 'a3', boxId: 'b1' }],
      mode: () => mode,
      windowMs: () => 300,
      tryPush: (id, text) => {
        if (!busy.has(id)) {
          return false;
        }
        pushed.push({ id, text });
        return true;
      },
      delivered: (d) => delivered.push(d),
    });
    const s2 = new BrainStore(root, 'conv-news');
    s2.onChange = (events) => news.add(events);
    await s2.upsertAgent({ id: 'a1', description: 'Autor', boxId: 'b1', status: 'running' });
    for (let i = 0; i < 4; i++) {
      await s2.fact({ title: `Achado ${i} do autor`, body: 'com detalhe', author: 'a1' });
    }
    assert.equal(pushed.length, 0, 'nada antes da janela');
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(pushed.map((p) => p.id).sort(), ['a2', 'main']);
    const a2 = pushed.find((p) => p.id === 'a2')!.text;
    assert.match(a2, /^Novidades no cérebro compartilhado/);
    assert.equal(a2.split('\n').filter((l) => /^- a1 · fatos\/.*achado-\d-do-autor\.md · Achado \d do autor$/.test(l)).length, 4);
    assert.ok(!/com detalhe/.test(a2), 'só o título');
    assert.equal(news.hasPending('a1'), false);
    assert.equal(news.hasPending('a3'), true);
    const later = news.take('a3')!;
    assert.equal(later.split('\n').filter((l) => l.startsWith('- a1 ·')).length, 4);
    assert.equal(news.take('a3'), undefined);
    assert.deepEqual(delivered.map((d) => `${d.to}:${d.count}:${d.how}`).sort(), ['a2:4:turno', 'a3:4:mensagem', 'main:4:turno']);
    mode = 'box';
    pushed.length = 0;
    await s2.write({ note: 'temas/caixa-b1', content: 'nota da caixa b1', author: 'a1' });
    news.flush();
    assert.deepEqual(pushed.map((p) => p.id), ['main']);
    assert.equal(news.hasPending('a3'), true);
    assert.equal(news.hasPending('a2'), false);
    const d = digest(
      [
        { rel: 'x.md', author: 'a9', line: 'de fora', boxId: 'b2', at: '2026-01-01T00:00:00Z' },
        { rel: 'y.md', author: 'a8', line: 'da caixa', boxId: 'b1', at: '2026-01-01T00:00:01Z' },
      ],
      'b1',
    );
    assert.ok(d.indexOf('da caixa') < d.indexOf('de fora'));
    news.reset();
  });

  await test('graphify e memória manual: o índice aponta, com aviso de idade, sem ler os arquivos', async () => {
    const g = path.join(root, 'cerebro', 'graphify-out');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'GRAPH_REPORT.md'), '# relatório\n');
    fs.writeFileSync(path.join(g, 'graph.json'), '{}');
    const old = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(path.join(g, 'GRAPH_REPORT.md'), old, old);
    const m = path.join(root, 'cerebro', 'raw', 'decisoes');
    fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, 'INDICE.md'), '# Índice\n');
    fs.writeFileSync(path.join(m, 'COMO_USAR.md'), '# Como usar\n');
    fs.writeFileSync(path.join(m, '2026-09-22-x.md'), '---\n---\n# x\n');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'graphify-out', 'graph.json'), '{}');
    const maps = findExternalMaps(root);
    assert.deepEqual(maps.map((x) => `${x.kind}:${x.path}`), ['grafo:cerebro/graphify-out/GRAPH_REPORT.md', 'memoria:cerebro/raw/decisoes/INDICE.md']);
    const fresh = new BrainStore(root, 'conv-1', { graphStaleDays: () => 14 });
    await fresh.write({ note: 'projeto', content: 'dispara o índice', author: 'a1' });
    const idx = read('index.md');
    assert.match(idx, /Mapa estático do código: \[cerebro\/graphify-out\/GRAPH_REPORT\.md\]\(\.\.\/\.\.\/cerebro\/graphify-out\/GRAPH_REPORT\.md\) \(gerado em .*, há 30 dias: pode estar desatualizado\)/);
    assert.match(idx, /nunca leia o arquivo inteiro, muito menos o graph\.json/);
    assert.match(idx, /Memória escrita à mão que já existe no projeto: \[cerebro\/raw\/decisoes\/INDICE\.md\]\(\.\.\/\.\.\/cerebro\/raw\/decisoes\/INDICE\.md\) \(1 notas\)/);
    assert.deepEqual(brokenLinks(), []);
  });

  await test('git não ignora o cérebro (só *.tmp)', () => {
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
    } catch {
      console.log('     (git ausente, pulado)');
      return;
    }
    fs.writeFileSync(path.join(root, '.agm', '.gitignore'), 'worktrees/\nverify-tmp/\ncache/\n*.tmp\n');
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '.agm/brain'], { cwd: root, encoding: 'utf8' });
    assert.match(out, /\.agm\/brain\/index\.md/);
    assert.match(out, /\.agm\/brain\/fatos\//);
  });

  console.log(failed ? `\n${failed} falharam (pasta: ${root})` : `\ntudo certo (pasta: ${root})`);
  process.exit(failed ? 1 : 0);
}
