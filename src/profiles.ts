import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { codexProfilesRoot, isSharedCodexHome, readCodexAuthStatus } from './codex';

export const DEFAULT_ID = 'default';
const PROFILES_KEY = 'profiles';
const ACTIVE_KEY = 'activeId';

export type Provider = 'claude' | 'codex';

export interface Profile {
  id: string;
  name: string;
  /**
   * Claude: pasta passada em CLAUDE_CONFIG_DIR (no perfil padrão fica ~/.claude e a variável não é definida).
   * Codex: pasta passada em CODEX_HOME.
   */
  configDir: string;
  /** Ausente nos perfis gravados antes do Codex existir: esses são do Claude. */
  provider?: Provider;
}

export function providerOf(profile: Profile): Provider {
  return profile.provider ?? 'claude';
}

export function isCodex(profile: Profile): boolean {
  return providerOf(profile) === 'codex';
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
  error?: string;
}

export function defaultProfile(): Profile {
  return { id: DEFAULT_ID, name: 'Padrão', configDir: path.join(os.homedir(), '.claude') };
}

export function profilesRoot(): string {
  const configured = vscode.workspace.getConfiguration('agentGraphMaster').get<string>('profilesRoot', '').trim();
  if (!configured) {
    return path.join(os.homedir(), '.claude-profiles');
  }
  return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
}

export function claudeCommand(): string {
  return vscode.workspace.getConfiguration('agentGraphMaster').get<string>('claudeCommand', 'claude').trim() || 'claude';
}

/** Valor de CLAUDE_CONFIG_DIR para o perfil, ou undefined quando a variável deve ficar ausente (ou a conta é do Codex). */
export function configDirEnv(profile: Profile): string | undefined {
  return profile.id === DEFAULT_ID || isCodex(profile) ? undefined : profile.configDir;
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'conta';
}

export class ProfileStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  all(): Profile[] {
    return [defaultProfile(), ...this.custom()];
  }

  get(id: string): Profile | undefined {
    return this.all().find((p) => p.id === id);
  }

  /** Conta do Claude escolhida para a extensão oficial e os terminais. Conta do Codex nunca é a ativa. */
  active(): Profile {
    const profile = this.get(this.state.get<string>(ACTIVE_KEY, DEFAULT_ID));
    return profile && !isCodex(profile) ? profile : defaultProfile();
  }

  async setActive(id: string): Promise<void> {
    await this.state.update(ACTIVE_KEY, id);
    this.changed.fire();
  }

  /**
   * Cria a conta. Por padrão ganha pasta própria na raiz do fornecedor; `existingDir` reaproveita uma pasta que já
   * tem login (ex.: ~/.codex, onde fica o login feito fora da extensão).
   */
  async add(name: string, provider: Provider = 'claude', existingDir?: string): Promise<Profile> {
    const codex = provider === 'codex';
    const root = codex ? codexProfilesRoot() : profilesRoot();
    const taken = new Set(this.all().map((p) => p.id));
    // Ids de conta Codex levam prefixo: as duas raízes podem ter pastas com o mesmo nome.
    const base = codex ? `codex-${slugify(name)}` : slugify(name);
    // Na raiz das contas Codex a pasta não repete o prefixo: `codex-trabalho` fica em ~/.codex-profiles/trabalho.
    const folder = (candidate: string) => path.join(root, codex ? candidate.replace(/^codex-/, '') : candidate);
    let id = base;
    for (let i = 2; taken.has(id) || id === DEFAULT_ID || (!existingDir && fs.existsSync(folder(id))); i++) {
      id = `${base}-${i}`;
    }
    const profile: Profile = { id, name, configDir: existingDir ?? folder(id) };
    if (codex) {
      profile.provider = 'codex';
    }
    await fs.promises.mkdir(profile.configDir, { recursive: true });
    await this.save([...this.custom(), profile]);
    return profile;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.save(this.custom().map((p) => (p.id === id ? { ...p, name } : p)));
  }

  async remove(id: string, deleteFolder: boolean): Promise<void> {
    const profile = this.custom().find((p) => p.id === id);
    if (!profile) {
      return;
    }
    if (this.active().id === id) {
      await this.state.update(ACTIVE_KEY, DEFAULT_ID);
    }
    await this.save(this.custom().filter((p) => p.id !== id));
    if (deleteFolder && !isSharedFolder(profile)) {
      await fs.promises.rm(profile.configDir, { recursive: true, force: true });
    }
  }

  /** Registra pastas que já existem na raiz de perfis mas sumiram da lista (ex.: depois de reinstalar a extensão). */
  async importOrphanFolders(): Promise<number> {
    const known = new Set(this.custom().map((p) => path.resolve(p.configDir).toLowerCase()));
    const ids = new Set(this.all().map((p) => p.id));
    const found: Profile[] = [];
    for (const provider of ['claude', 'codex'] as const) {
      const root = provider === 'codex' ? codexProfilesRoot() : profilesRoot();
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const dir = path.join(root, entry.name);
        const id = provider === 'codex' && !entry.name.startsWith('codex-') ? `codex-${entry.name}` : entry.name;
        if (!entry.isDirectory() || known.has(path.resolve(dir).toLowerCase()) || entry.name === DEFAULT_ID || ids.has(id)) {
          continue;
        }
        ids.add(id);
        found.push(provider === 'codex' ? { id, name: entry.name.replace(/^codex-/, ''), configDir: dir, provider } : { id, name: entry.name, configDir: dir });
      }
    }
    if (found.length) {
      await this.save([...this.custom(), ...found]);
    }
    return found.length;
  }

  private custom(): Profile[] {
    return this.state.get<Profile[]>(PROFILES_KEY, []);
  }

  private async save(profiles: Profile[]): Promise<void> {
    await this.state.update(PROFILES_KEY, profiles);
    this.changed.fire();
  }
}

/** Pastas que existiam antes da conta (login padrão do Claude ou do Codex): remover a conta não apaga. */
export function isSharedFolder(profile: Profile): boolean {
  return profile.id === DEFAULT_ID || (isCodex(profile) && isSharedCodexHome(profile.configDir));
}

/** Pergunta ao próprio CLI quem está logado nesse perfil. Não lê nem copia token. */
export function readAuthStatus(profile: Profile): Promise<AuthStatus> {
  if (isCodex(profile)) {
    return readCodexAuthStatus(profile);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dir = configDirEnv(profile);
  if (dir) {
    env.CLAUDE_CONFIG_DIR = dir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  return new Promise((resolve) => {
    exec(`${claudeCommand()} auth status --json`, { env, timeout: 20000, windowsHide: true }, (err, stdout) => {
      try {
        const data = JSON.parse(stdout);
        resolve({
          loggedIn: !!data.loggedIn,
          email: data.email,
          subscriptionType: data.subscriptionType,
          authMethod: data.authMethod,
        });
      } catch {
        // Sem login o CLI sai com código diferente de zero, mas ainda imprime JSON; só cai aqui se nem isso veio.
        resolve({ loggedIn: false, error: err ? err.message.split('\n')[0] : 'resposta inesperada do CLI' });
      }
    });
  });
}
