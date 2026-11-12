import fs from 'node:fs/promises';
import path from 'node:path';

/** A tiny JSON file that remembers which reminders went out. PayPal doesn't hand this back. */
export class ReminderLog {
  constructor(dir) {
    this.file = path.join(dir, 'reminders.json');
    this.cache = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async forInvoice(id) {
    const all = await this.load();
    return all[id] || [];
  }

  async all() {
    return this.load();
  }

  async countOn(id, isoDay) {
    return (await this.forInvoice(id)).filter((r) => r.at.slice(0, 10) === isoDay).length;
  }

  async add(id, entry) {
    const all = await this.load();
    (all[id] ||= []).push(entry);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all, null, 2));
      await fs.rename(tmp, this.file);
    });
    await this.writing;
  }
}
