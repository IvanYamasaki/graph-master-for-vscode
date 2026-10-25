import * as assert from 'assert';
import { ago, recentRows } from './sidebarModel';

const now = 1_000_000_000_000;
assert.strictEqual(ago(now - 5_000, now), 'agora');
assert.strictEqual(ago(now - 5 * 60_000, now), 'há 5 min');
assert.strictEqual(ago(now - 2 * 3_600_000, now), 'há 2 h');
assert.strictEqual(ago(now - 3 * 86_400_000, now), 'há 3 d');
assert.strictEqual(ago(now - 21 * 86_400_000, now), 'há 3 sem');
assert.strictEqual(ago(now - 95 * 86_400_000, now), 'há 3 meses');
assert.strictEqual(ago(now + 5_000, now), 'agora');

const entries = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, lastModified: now - i * 3_600_000, profileId: 'p', profileName: 'Pessoal' }));
const rows = recentRows(entries, now);
assert.strictEqual(rows.length, 15);
assert.strictEqual(rows[0].description, 'Pessoal · agora');
assert.strictEqual(rows[2].description, 'Pessoal · há 2 h');
console.log('sidebarModel ok');
