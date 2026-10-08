import { SessionStore } from './sessionStore';
import { threadsFromStore, threadsToStore, type AgentPost, type PostThread, type StoredThreads } from './threadModel';

/**
 * Onde os posts e as threads de uma conversa ficam guardados. Interface pequena de propósito: quem usa não sabe se
 * é arquivo ou memento.
 */
export interface ThreadPersistence {
  load(mainSessionId: string): StoredThreads;
  save(mainSessionId: string, posts: AgentPost[], threads: PostThread[]): void;
}

const KEY = 'threads';

/** Posts e threads em .agm/sessions/<conversa>/threads.json, junto com o resto do que reabre a conversa igual. */
export class FolderThreadStore implements ThreadPersistence {
  private readonly store: SessionStore;

  constructor(root: string) {
    this.store = SessionStore.for(root);
  }

  load(mainSessionId: string): StoredThreads {
    return threadsFromStore(this.store.read(mainSessionId, KEY));
  }

  save(mainSessionId: string, posts: AgentPost[], threads: PostThread[]): void {
    const kept = threadsToStore(posts, threads);
    if (kept.posts.length || kept.threads.length) {
      this.store.write(mainSessionId, KEY, kept);
    } else if (this.store.has(mainSessionId, KEY)) {
      this.store.remove(mainSessionId, KEY);
    }
  }
}
