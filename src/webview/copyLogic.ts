/** Decisões puras da cópia de texto do chat (sem DOM, para dar para testar). */

export interface CopyChoice {
  text: string;
  /** true: copiou só o trecho selecionado, não a mensagem inteira. */
  partial: boolean;
}

/** Com trecho selecionado dentro da mensagem copia só ele; sem seleção (ou só espaços), a mensagem inteira. */
export function pickCopyText(selected: string, whole: string): CopyChoice {
  return selected.trim() ? { text: selected, partial: true } : { text: whole, partial: false };
}

/** Rótulo do botão de copiar da mensagem: avisa o que vai para a área de transferência. */
export function copyLabel(partial: boolean, noun = 'o texto'): string {
  return partial ? 'Copiar o trecho selecionado' : `Copiar ${noun}`;
}

/** Linguagem de um bloco de código a partir da classe que o marked põe no <code> ("language-ts"). */
export function codeLang(className: string): string {
  const m = /(?:^|\s)language-([^\s]+)/.exec(className);
  return m ? m[1] : '';
}

/** Texto cru do bloco: o marked fecha o código com uma quebra de linha que não faz parte dele. */
export function blockText(raw: string): string {
  return raw.replace(/\r?\n$/, '');
}
