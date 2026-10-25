import { blockText, codeLang, copyLabel, pickCopyText } from './copyLogic';

function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) {
    console.error(`FALHOU ${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    process.exit(1);
  }
}
eq(pickCopyText('trecho', 'mensagem inteira').text, 'trecho', 'seleção vence');
eq(pickCopyText('trecho', 'mensagem inteira').partial, true, 'seleção é parcial');
eq(pickCopyText('', 'mensagem inteira').text, 'mensagem inteira', 'sem seleção copia tudo');
eq(pickCopyText('  \n ', 'mensagem inteira').partial, false, 'seleção só de espaço não conta');
eq(copyLabel(true), 'Copiar o trecho selecionado', 'rótulo parcial');
eq(copyLabel(false, 'o texto do post'), 'Copiar o texto do post', 'rótulo inteiro');
eq(codeLang('language-ts'), 'ts', 'linguagem');
eq(codeLang('hljs language-c++ x'), 'c++', 'linguagem no meio');
eq(codeLang(''), '', 'sem linguagem');
eq(blockText('a\nb\n'), 'a\nb', 'tira a quebra final');
eq(blockText('a\n\n'), 'a\n', 'só uma quebra');
eq(blockText('a\r\n'), 'a', 'crlf');
console.log('ok');
