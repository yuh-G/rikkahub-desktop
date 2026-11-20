-- 迁移 0004:引擎宿主进程重启次数(重构方案 D24)。工作区引擎与插件跑在独立的引擎宿主进程里,
-- 它意外退出(崩溃、卡死被强杀、停止不响应、启动失败)后应用会自动重启它;客户端上报当日重启次数 rs。
-- 只对"已存在旧结构 pings 表"的线上库执行一次:
--   npx wrangler d1 execute <DB_NAME> --remote --file=functions/_sql/0004_engine_restarts.sql
-- SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS,重复执行会报 duplicate column,属预期。
-- 部署顺序:先执行本迁移,再部署新版 functions(ping.ts 写新列,列不存在会 500)。
ALTER TABLE pings ADD COLUMN engine_restarts INTEGER NOT NULL DEFAULT 0;
