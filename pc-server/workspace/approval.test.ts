// workspace/approval.test.ts — cwd 词法解析与危险命令清单单测(纯函数层)
// 三档矩阵、下界与终局、免审前缀的判定测试在 tools/permission.test.ts(判定改按类别后)。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDangerousCommandReason, lexicalWorkspaceCwd } from "./approval";

// 词法判定不碰文件系统,root 无需真实存在
const ROOT = join(tmpdir(), "rkh-approval-root");

describe("会话 cwd 词法解析", () => {
  test("空值回 root;相对值按 root 解析;词法越界回 root", () => {
    expect(lexicalWorkspaceCwd(ROOT, null)).toBe(ROOT);
    expect(lexicalWorkspaceCwd(ROOT, "sub")).toBe(join(ROOT, "sub"));
    expect(lexicalWorkspaceCwd(ROOT, join(tmpdir(), "other"))).toBe(ROOT);
  });
});

describe("危险命令拦截清单(任何档位都拦,§3.2)", () => {
  const dangerous = [
    "rm -rf /",
    "rm -fr /",
    "rm -rf ~",
    "rm -rf $HOME",
    "sudo rm -rf /",
    "rm -rf / --no-preserve-root",
    "rm -rf /etc",
    "rm -rf /usr && echo done",
    "rm -rf C:\\",
    "rm -rf c:/",
    'rm -rf "C:\\"',
    "del /s /q C:\\",
    "rd /s /q C:",
    "mkfs.ext4 /dev/sda1",
    "mkfs /dev/sdb",
    "format C:",
    "echo hi && diskpart",
    "dd if=/dev/zero of=/dev/sda",
    "cat /dev/urandom > /dev/sda",
    "chmod -R 777 /",
    'reg delete "HKLM\\SOFTWARE" /f',
    ":(){ :|:& };:",
  ];
  for (const cmd of dangerous) {
    test(`拦截: ${cmd}`, () => {
      expect(findDangerousCommandReason(cmd)).not.toBeNull();
    });
  }

  const safe = [
    "ls -la",
    "rm -rf ./build",
    "rm -rf node_modules",
    "rm -rf /tmp/mydir",
    "rm foo.txt",
    "rm -rf src/generated && bun run codegen",
    "git rm -r --cached .",
    "del build\\out.txt",
    "echo 'rm -rf /' > docs/danger-examples.md", // 字面量写入文档不执行……但保守拦截也可接受?不:重定向目标非设备,正则不命中
    "dd if=./disk.img of=./backup.img",
    "chmod 755 scripts/build.sh",
    "chmod -R 644 ./dist",
    "reg query HKCU\\Software",
    "format-code --all",
    "grep -r 'mkfs' docs/",
  ];
  for (const cmd of safe) {
    test(`放行: ${cmd}`, () => {
      expect(findDangerousCommandReason(cmd)).toBeNull();
    });
  }
});
