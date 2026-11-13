// pi-engine/agent-dir.test.ts — pi 数据目录(P5.1):插件看到的 getAgentDir() 是应用的 engines/pi/;
// pi 的默认资源发现(用户家目录的 ~/.agents/skills、数据目录里的 skills/)保持关闭(E1 的技能泄漏)。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pi-agent-dir-test-"));

const { dataDir, piAgentDir } = await import("../foundation/paths");
const { ENV_AGENT_DIR, getAgentDir } = await import("../../pi/packages/coding-agent/src/config.ts");
const { bindPiAgentDir } = await import("./agent-dir");
const { createPiDriver } = await import("./driver");
const { createPiSessionResources } = await import("./resources");

const priorHome = process.env.HOME;
const priorAgentDir = process.env[ENV_AGENT_DIR];
afterAll(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
  else process.env[ENV_AGENT_DIR] = priorAgentDir;
  // 共享路径落笔即清(model-bridge.test 断言 pi 数据目录零落盘)。
  rmSync(piAgentDir, { recursive: true, force: true });
});

function makeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`, "utf-8");
}

describe("pi 数据目录", () => {
  test("在应用数据目录的 engines/pi/ 下", () => {
    expect(piAgentDir).toBe(join(dataDir, "engines", "pi"));
  });

  test("驱动创建即把 getAgentDir() 指过来,覆盖用户环境里原有的值", () => {
    process.env[ENV_AGENT_DIR] = join(tmpdir(), "users-own-pi-agent");
    createPiDriver({} as never);
    expect(getAgentDir()).toBe(piAgentDir);
    bindPiAgentDir();
    expect(process.env[ENV_AGENT_DIR]).toBe(piAgentDir);
  });

  test("默认技能发现关闭:家目录 ~/.agents/skills 与数据目录 skills/ 里的技能都不加载", async () => {
    const home = mkdtempSync(join(tmpdir(), "rkh-fake-home-"));
    process.env.HOME = home;
    makeSkill(join(home, ".agents", "skills"), "home-leak");
    makeSkill(join(piAgentDir, "skills"), "agent-dir-leak");
    const libraryDir = mkdtempSync(join(tmpdir(), "rkh-skill-library-"));
    makeSkill(libraryDir, "library-skill");
    const cwd = mkdtempSync(join(tmpdir(), "rkh-agent-dir-ws-"));

    const { resourceLoader } = await createPiSessionResources({
      cwd,
      root: cwd,
      instructions: {
        appendSystemPrompt: [],
        globalAgentsFile: null,
        skills: { dir: libraryDir, enabled: ["library-skill", "home-leak", "agent-dir-leak"] },
      },
    });
    expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["library-skill"]);
    rmSync(home, { recursive: true, force: true });
  });
});
