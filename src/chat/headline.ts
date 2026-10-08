/**
 * Conclusão de um relatório em uma frase curta, para o cartão do agente no chat. Os agentes abrem o relatório com
 * "Resumo: ..." (está no guia deles); sem essa linha, vale a primeira frase do texto. Sem modelo: custo zero.
 */
const LEAD = /^(?:resumo|conclus[aã]o|tl;?dr|resultado)\s*[:：—–-]\s*/i;

function plain(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

export function reportHeadline(report: string | undefined, max = 110): string {
  if (!report?.trim()) {
    return '';
  }
  const lines = report
    .split('\n')
    .map(plain)
    .filter((l) => l && !/^[-=_*|]{3,}$/.test(l));
  const marked = lines.find((l) => LEAD.test(l));
  if (marked) {
    return clip(marked.replace(LEAD, '').trim(), max);
  }
  // Título curto ("Relatório", "Resultado da análise") não conclui nada: pula para a primeira frase de verdade.
  const first = lines.find((l) => l.split(' ').length > 4 && !/:$/.test(l)) ?? lines[0] ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
  return clip(sentence, max);
}
