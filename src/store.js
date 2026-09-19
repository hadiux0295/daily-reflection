// Journal + profile store. Thin interface over node:sqlite so the backend can be swapped
// (Cloud Run has no persistent disk — see DESIGN.md §1 D4). All methods are synchronous.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** `journal` = SQLite journal_mode. WAL needs shared memory + POSIX locks, which FUSE mounts (Cloud Run GCS volumes)
 *  do not provide → use "DELETE" there (env DR_SQLITE_JOURNAL). Single instance only (max-instances 1). */
export function openStore(path = ":memory:", { journal = process.env.DR_SQLITE_JOURNAL || "WAL" } = {}) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (!/^(WAL|DELETE|TRUNCATE|PERSIST|MEMORY)$/i.test(journal)) throw new Error(`bad DR_SQLITE_JOURNAL: ${journal}`);
  db.exec(`
    PRAGMA journal_mode = ${journal.toUpperCase()};
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      birth_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      date TEXT NOT NULL,
      text TEXT NOT NULL,
      mood TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_profile_date ON entries(profile_id, date);
  `);
  const q = {
    getProfile: db.prepare("SELECT birth_json FROM profiles WHERE profile_id = ?"),
    putProfile: db.prepare("INSERT INTO profiles(profile_id, birth_json, created_at) VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET birth_json = excluded.birth_json"),
    delProfile: db.prepare("DELETE FROM profiles WHERE profile_id = ?"),
    delEntries: db.prepare("DELETE FROM entries WHERE profile_id = ?"),
    addEntry: db.prepare("INSERT INTO entries(id, profile_id, date, text, mood, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    listEntries: db.prepare("SELECT id, date, text, mood, tags_json FROM entries WHERE profile_id = ? AND date >= ? ORDER BY date DESC, created_at DESC"),
    dates: db.prepare("SELECT DISTINCT date FROM entries WHERE profile_id = ? ORDER BY date DESC"),
    count: db.prepare("SELECT COUNT(*) AS n FROM entries WHERE profile_id = ?"),
  };
  return {
    getBirth(profileId) {
      const row = q.getProfile.get(profileId);
      return row && row.birth_json ? JSON.parse(row.birth_json) : null;
    },
    putBirth(profileId, birth) {
      q.putProfile.run(profileId, JSON.stringify(birth), new Date().toISOString());
    },
    deleteProfile(profileId) {
      const a = q.delEntries.run(profileId).changes;
      const b = q.delProfile.run(profileId).changes;
      return { entries_deleted: a, profile_deleted: b > 0 };
    },
    addEntry(profileId, { date, text, mood = null, tags = [] }) {
      const id = randomUUID().slice(0, 8);
      q.addEntry.run(id, profileId, date, text, mood, JSON.stringify(tags), new Date().toISOString());
      return id;
    },
    listEntries(profileId, sinceDate) {
      return q.listEntries.all(profileId, sinceDate).map((r) => ({ ...r, tags: JSON.parse(r.tags_json), tags_json: undefined }));
    },
    entryDates(profileId) { return q.dates.all(profileId).map((r) => r.date); },
    entryCount(profileId) { return q.count.get(profileId).n; },
    close() { db.close(); },
  };
}
