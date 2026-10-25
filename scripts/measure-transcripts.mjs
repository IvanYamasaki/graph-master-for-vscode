// Mede o que os transcritos do CLI trariam para a memória do host e do webview (itens por agente, texto de
// resultado de ferramenta, bytes além do que o webview mostra, imagens). Uso:
//   node scripts/measure-transcripts.mjs <pasta de projects/<cwd>> [horas=48]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const hours = Number(process.argv[3] ?? 48);
if (!dir) {
  console.error('uso: node scripts/measure-transcripts.mjs <pasta> [horas]');
  process.exit(1);
}
const CLIP = 6000;
const since = Date.now() - hours * 3600_000;
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= since) files.push(p);
  }
})(dir);

const total = { files: files.length, items: 0, resultChars: 0, beyondClip: 0, imageChars: 0, images: 0, textChars: 0, inputChars: 0, maxResult: 0 };
const rows = [];
for (const f of files) {
  const r = { f: path.basename(f), items: 0, resultChars: 0, beyondClip: 0, imageChars: 0, images: 0 };
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const content = m.message?.content;
    if (!Array.isArray(content)) { if (typeof content === 'string') { total.textChars += content.length; r.items++; } continue; }
    for (const b of content) {
      r.items++;
      if (b.type === 'text') total.textChars += b.text?.length ?? 0;
      else if (b.type === 'tool_use') total.inputChars += JSON.stringify(b.input ?? '').length;
      else if (b.type === 'tool_result') {
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : (b.content ?? []);
        let text = 0;
        for (const c of parts) {
          if (c.type === 'text') text += c.text?.length ?? 0;
          else if (c.type === 'image') { r.images++; r.imageChars += c.source?.data?.length ?? 0; }
        }
        r.resultChars += text;
        r.beyondClip += Math.max(0, text - CLIP);
        total.maxResult = Math.max(total.maxResult, text);
      }
    }
  }
  rows.push(r);
  for (const k of ['items', 'resultChars', 'beyondClip', 'imageChars', 'images']) total[k] += r[k];
}
rows.sort((a, b) => b.resultChars + b.imageChars - (a.resultChars + a.imageChars));
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log('maiores transcritos:');
for (const r of rows.slice(0, 8)) console.log(`  ${r.f}  itens=${r.items} resultados=${mb(r.resultChars)} alémDe${CLIP}=${mb(r.beyondClip)} imagens=${r.images} (${mb(r.imageChars)})`);
console.log('total:', { ...total, resultChars: mb(total.resultChars), beyondClip: mb(total.beyondClip), imageChars: mb(total.imageChars), textChars: mb(total.textChars), inputChars: mb(total.inputChars), maxResult: mb(total.maxResult) });
