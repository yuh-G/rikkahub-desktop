-- 迁移 0002:遥测扩展(国家码 / 心跳时长 / 失败数 / 功能计数)。
-- 只对"已存在旧结构 pings 表"的线上库执行一次:
--   npx wrangler d1 execute <DB_NAME> --remote --file=functions/_sql/0002_telemetry_extend.sql
-- SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS,重复执行会报 duplicate column,属预期。
ALTER TABLE pings ADD COLUMN country     TEXT    NOT NULL DEFAULT '';
ALTER TABLE pings ADD COLUMN hb_count    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pings ADD COLUMN err_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pings ADD COLUMN feat_search INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pings ADD COLUMN feat_tts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pings ADD COLUMN feat_mcp    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pings ADD COLUMN feat_img    INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pings_date ON pings(date);
