-- pings: one row per device per day, upserted on every ping
CREATE TABLE IF NOT EXISTS pings (
  device_id  TEXT NOT NULL,
  date       TEXT NOT NULL,            -- YYYY-MM-DD in user's local time
  version    TEXT NOT NULL DEFAULT '',
  os         TEXT NOT NULL DEFAULT '',
  msg_count  INTEGER NOT NULL DEFAULT 0,
  first_seen BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (device_id, date)
);

-- daily_summary: pre-aggregated metrics for fast dashboard queries
CREATE TABLE IF NOT EXISTS daily_summary (
  date         TEXT PRIMARY KEY,
  dau          INTEGER NOT NULL DEFAULT 0,
  eff_dau      INTEGER NOT NULL DEFAULT 0,  -- users who sent >= 1 message
  new_users    INTEGER NOT NULL DEFAULT 0,
  total_msgs   INTEGER NOT NULL DEFAULT 0,
  win_users    INTEGER NOT NULL DEFAULT 0,
  linux_users  INTEGER NOT NULL DEFAULT 0,
  mac_users    INTEGER NOT NULL DEFAULT 0
);

-- version_distribution: snapshot of active versions per day
CREATE TABLE IF NOT EXISTS version_dist (
  date    TEXT NOT NULL,
  version TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, version)
);
