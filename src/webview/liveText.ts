/**
 * Falas do orquestrador em streaming: um bloco por trecho de texto (chave msgId:index), que recebe os deltas e depois
 * o texto final (`assistantText`), que substitui o parcial.
 *
 * Stream que cai no meio: o CLI refaz a resposta (nova tentativa em streaming ou sem streaming) e ela chega com outro
 * id de mensagem. Sem cuidado, a bolha do stream morto ficava cortada no meio de uma palavra e o texto inteiro entrava
 * como outra bolha embaixo. O texto de uma mensagem fecha (assistantText) antes de a próxima começar; então o bloco
 * aberto de outra mensagem é órfão, e a mensagem nova assume o lugar dele.
 */

export interface LiveBlock<E> {
  el: E;
  /** Texto juntado dos deltas. */
  text: string;
  msgId: string;
  /** Já recebeu o texto final: delta atrasado não repinta. */
  final: boolean;
}

export class LiveTexts<E> {
  private readonly blocks = new Map<string, LiveBlock<E>>();

  /**
   * `adopt`: a mensagem nova assume o bloco órfão de outra mensagem. Só no Claude: no Codex os itens têm vida
   * própria e o comportamento antigo (um bloco por item) continua.
   */
  constructor(
    private readonly make: () => E,
    private readonly adopt: () => boolean = () => true,
  ) {}

  /** Bloco aberto de outra mensagem: o stream dele morreu sem texto final. */
  private orphan(msgId: string): LiveBlock<E> | undefined {
    if (!this.adopt()) {
      return undefined;
    }
    let found: LiveBlock<E> | undefined;
    for (const b of this.blocks.values()) {
      if (!b.final && b.msgId !== msgId) {
        found = b;
      }
    }
    return found;
  }

  private rekey(block: LiveBlock<E>, key: string): void {
    for (const [k, b] of this.blocks) {
      if (b === block) {
        this.blocks.delete(k);
      }
    }
    this.blocks.set(key, block);
  }

  /** Delta de texto. `created`: bloco novo, que precisa entrar no log; o de um órfão assumido já está lá. */
  delta(msgId: string, index: number, text: string): { key: string; block: LiveBlock<E>; created: boolean } {
    const key = `${msgId}:${index}`;
    let block = this.blocks.get(key);
    let created = false;
    if (!block) {
      const dead = this.orphan(msgId);
      if (dead) {
        // A nova tentativa recomeça o texto do zero, no lugar do parcial.
        block = dead;
        block.msgId = msgId;
        block.text = '';
        this.rekey(block, key);
      } else {
        block = { el: this.make(), text: '', msgId, final: false };
        this.blocks.set(key, block);
        created = true;
      }
    }
    block.text += text;
    return { key, block, created };
  }

  get(key: string): LiveBlock<E> | undefined {
    return this.blocks.get(key);
  }

  /**
   * Texto final de um trecho: o bloco aberto desta mensagem ou, se não houver, o órfão de um stream que caiu (a
   * resposta refeita sem streaming chega inteira, com outro id). Marca como final. Undefined: não havia bolha.
   */
  final(msgId: string): LiveBlock<E> | undefined {
    let block = [...this.blocks.values()].find((b) => b.msgId === msgId && !b.final);
    if (!block) {
      block = this.orphan(msgId);
      if (block) {
        block.msgId = msgId;
      }
    }
    if (block) {
      block.final = true;
    }
    return block;
  }

  /**
   * Fim do turno: o que ainda está aberto não recebe mais nada (stream perdido sem resposta refeita). Fica como está e
   * não é assumido por uma mensagem do próximo turno, que iria parar no lugar dele, lá em cima.
   */
  settle(): LiveBlock<E>[] {
    const open = [...this.blocks.values()].filter((b) => !b.final);
    for (const b of open) {
      b.final = true;
    }
    return open;
  }

  clear(): void {
    this.blocks.clear();
  }
}
