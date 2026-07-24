-- RikkaHub 遥测 D1 库结构参考(与线上保持同步,灾备重建/新环境初始化用)。
-- 应用方式:npx wrangler d1 execute <DB_NAME> --remote --file=functions/_sql/schema.sql
-- 全部 IF NOT EXISTS,对已有库执行只会补缺失的索引,不动数据。
-- 已有库补新列请执行 0002_telemetry_extend.sql(只跑一次)。

-- 原始上报:每设备每天一行,计数列取当日最大值(客户端每 10 分钟心跳累计,当日单调递增)。
CREATE TABLE IF NOT EXISTS pings (
  device_id   TEXT    NOT NULL,                            -- 客户端随机 UUID,无个人信息
  date        TEXT    NOT NULL,                            -- YYYY-MM-DD(客户端本地日,服务端钳制在 UTC ±1 天)
  version     TEXT    NOT NULL DEFAULT '',                 -- 白名单 [\w.\-+ ]{0,32},非法降级空串
  os          TEXT    NOT NULL DEFAULT '',                 -- win / mac / linux / ''(其他)
  country     TEXT    NOT NULL DEFAULT '',                 -- CF 边缘的 ISO 3166-1 两位国家码,不存 IP
  msg_count   INTEGER NOT NULL DEFAULT 0,                  -- 当日累计发送消息数,上限 999999
  hb_count    INTEGER NOT NULL DEFAULT 0,                  -- 当日心跳数(每 10 分钟 1 跳,≈使用时长/10min)
  err_count   INTEGER NOT NULL DEFAULT 0,                  -- 当日 provider 请求失败数(不含用户主动中断)
  feat_search INTEGER NOT NULL DEFAULT 0,                  -- 当日联网搜索/抓取次数
  feat_tts    INTEGER NOT NULL DEFAULT 0,                  -- 当日 TTS 朗读次数
  feat_mcp    INTEGER NOT NULL DEFAULT 0,                  -- 当日 MCP 工具调用次数
  feat_img    INTEGER NOT NULL DEFAULT 0,                  -- 当日图像生成次数
  first_seen  INTEGER NOT NULL DEFAULT 0,                  -- 仅设备历史首日为 1(rebuild 可全量矫正)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (device_id, date)
);

-- 主键 (device_id, date) 只覆盖按设备的前缀查询,而 stats 端几乎所有聚合都按日期
-- 区间扫描,必须有独立的 date 索引,否则每张图都是全表扫。
CREATE INDEX IF NOT EXISTS idx_pings_date ON pings(date);

-- 日汇总缓存:ping 端 refreshDay 维护,stats 无筛选时直读,避免每次全量聚合 pings。
CREATE TABLE IF NOT EXISTS daily_summary (
  date        TEXT PRIMARY KEY,
  dau         INTEGER NOT NULL DEFAULT 0,
  eff_dau     INTEGER NOT NULL DEFAULT 0,                 -- 当日发过 ≥1 条消息的设备
  new_users   INTEGER NOT NULL DEFAULT 0,
  total_msgs  INTEGER NOT NULL DEFAULT 0,
  win_users   INTEGER NOT NULL DEFAULT 0,
  linux_users INTEGER NOT NULL DEFAULT 0,
  mac_users   INTEGER NOT NULL DEFAULT 0
);

-- 每日版本分布缓存:供版本采用曲线,仅在新设备行或版本变化时重建当日。
CREATE TABLE IF NOT EXISTS version_dist (
  date    TEXT    NOT NULL,
  version TEXT    NOT NULL DEFAULT '',
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, version)
);
