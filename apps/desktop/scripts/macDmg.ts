#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export default async function prepareMacDmg() {
  const directory = resolve(import.meta.dir, "../../../build/desktop/macTools");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "hdiutil");
  const result = await Bun.build({ entrypoints: [import.meta.filename], target: "bun", outdir: directory, naming: "hdiutil" });
  if (!result.success) throw new AggregateError(result.logs, "无法准备 macOS 安装引导。");
  chmodSync(target, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
}

async function run(command: string[], input?: string) {
  const child = Bun.spawn(command, {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "inherit",
    stderr: "inherit",
    timeout: command[0] === "/usr/bin/osascript" ? 120000 : 600000,
  });
  if (await child.exited !== 0) throw new Error(`macOS 安装镜像制作失败：${command[0]} ${command[1]}`);
}

function getDmgDevice(imagePath: string) {
  const info = Bun.spawnSync(["/usr/bin/hdiutil", "info", "-plist"], {
    stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: 30000,
  });
  if (info.exitCode !== 0) throw new Error("无法读取已附加的 macOS 镜像。");
  // ACT: plist 含 NSData，不能整份转 JSON；系统 Foundation 只投影镜像路径与设备名，不引入解析依赖。
  const projection = Bun.spawnSync(["/usr/bin/osascript", "-l", "JavaScript", "-e", `
ObjC.import("Foundation");
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
if (plist.isNil() || !plist.isKindOfClass($.NSDictionary)) throw new Error("镜像属性列表无效");
const images = plist.objectForKey("images");
if (images.isNil() || !images.isKindOfClass($.NSArray)) throw new Error("镜像列表无效");
const result = [];
for (let index = 0; index < images.count; index++) {
  const image = images.objectAtIndex(index);
  if (image.isNil() || !image.isKindOfClass($.NSDictionary)) throw new Error("镜像记录无效");
  const path = image.objectForKey("image-path");
  const entities = image.objectForKey("system-entities");
  if (path.isNil() || entities.isNil() || !path.isKindOfClass($.NSString) || !entities.isKindOfClass($.NSArray)) throw new Error("镜像信息无效");
  const devices = [];
  for (let index = 0; index < entities.count; index++) {
    const entity = entities.objectAtIndex(index);
    if (entity.isNil() || !entity.isKindOfClass($.NSDictionary)) throw new Error("镜像设备记录无效");
    const device = entity.objectForKey("dev-entry");
    if (device.isNil() || !device.isKindOfClass($.NSString)) throw new Error("镜像设备信息无效");
    devices.push(ObjC.unwrap(device));
  }
  result.push({ imagePath: ObjC.unwrap(path), devices });
}
JSON.stringify(result);
`], { stdin: info.stdout, stdout: "pipe", stderr: "inherit", timeout: 30000 });
  if (projection.exitCode !== 0) throw new Error("无法解析已附加的 macOS 镜像。");
  const images = JSON.parse(projection.stdout.toString()) as { imagePath: string; devices: string[] }[];
  if (!Array.isArray(images) || images.some(image => typeof image?.imagePath !== "string"
    || !Array.isArray(image.devices) || image.devices.some(device => typeof device !== "string"))) {
    throw new Error("macOS 镜像信息格式无效。");
  }
  const canonicalPath = existsSync(imagePath) ? realpathSync(imagePath) : join(realpathSync(dirname(imagePath)), basename(imagePath));
  const matches = images.filter(image => image.imagePath === imagePath || image.imagePath === canonicalPath
    || (existsSync(image.imagePath) && realpathSync(image.imagePath) === canonicalPath));
  if (matches.length === 0) return;
  if (matches.length !== 1) throw new Error(`安装镜像对应多个附加记录，拒绝卸载：${imagePath}`);
  const devices = matches[0]!.devices.filter(device => /^\/dev\/disk\d+$/.test(device));
  if (devices.length !== 1) throw new Error(`无法确定安装镜像的唯一磁盘设备：${imagePath}`);
  return devices[0]!;
}

async function detachDmg(imagePath: string) {
  // ACT: 卷目录消失不代表镜像脱离；busy 或成功后仍附加时有限重试，间隔合计 10 秒，每次卸载最多 30 秒。
  for (let attempt = 1; attempt <= 5; attempt++) {
    const device = getDmgDevice(imagePath);
    if (!device) return;
    const child = Bun.spawn(["/usr/bin/hdiutil", "detach", device], {
      env: { ...process.env, LC_ALL: "C" }, stdin: "ignore", stdout: "inherit", stderr: "pipe", timeout: 30000,
    });
    const [exitCode, message] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    process.stderr.write(message);
    if (!getDmgDevice(imagePath)) return;
    if ((exitCode !== 0 && !message.includes("Resource busy")) || attempt === 5) {
      throw new Error(`macOS 安装镜像仍附加（退出码 ${exitCode}）：${imagePath}`);
    }
    console.warn(`安装镜像仍附加，${attempt} 秒后重试卸载（${attempt}/4）：${device}`);
    await Bun.sleep(attempt * 1000);
  }
}

async function createDmg(args: string[]) {
  const sourceIndex = args.indexOf("-srcfolder");
  if (args[0] !== "create" || sourceIndex < 0) {
    const child = Bun.spawn(["/usr/bin/hdiutil", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await child.exited);
  }
  const source = args[sourceIndex + 1];
  const output = args.at(-1);
  const formatIndex = args.indexOf("-format");
  const volumeIndex = args.indexOf("-volname");
  const volumeName = args[volumeIndex + 1];
  if (!source || !output || formatIndex < 0 || volumeIndex < 0 || !volumeName || basename(volumeName) !== volumeName || [".", ".."].includes(volumeName)) {
    throw new Error("缺少或无效的 macOS 安装镜像参数。");
  }
  // ACT: 保留 /Volumes 供 Finder 解析背景别名，用独立挂载路径隔离每次构建，卷名仍保持不变。
  const mountPath = join("/Volumes", `${volumeName}-${crypto.randomUUID()}`);
  if (existsSync(mountPath)) throw new Error(`请先推出同名安装镜像再打包：${mountPath}`);
  const apps = readdirSync(source).filter(name => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("macOS 安装镜像必须包含且仅包含一个应用。");
  const background = join(source, ".background");
  mkdirSync(background, { recursive: true });
  if (!existsSync(join(source, "Applications"))) throw new Error("macOS 安装镜像缺少 Applications 快捷方式。");

  // ACT: 使用 macOS 自带 AppKit 绘制文字和箭头，不引入图片或 DMG 构建依赖。
  await run(["/usr/bin/osascript", "-l", "JavaScript", "-", join(background, "install.png")], `
ObjC.import("AppKit");
function run(args) {
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(640, 400));
  image.lockFocus;
  $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.97, 0.98, 1, 1).set;
  $.NSRectFill($.NSMakeRect(0, 0, 640, 400));
  function text(value, y, size, color) {
    const style = $.NSMutableParagraphStyle.alloc.init;
    style.alignment = $.NSTextAlignmentCenter;
    $(value).drawInRectWithAttributes($.NSMakeRect(20, y, 600, size + 10), $({
      NSFont: $.NSFont.systemFontOfSize(size),
      NSColor: color,
      NSParagraphStyle: style
    }));
  }
  const dark = $.NSColor.colorWithCalibratedWhiteAlpha(0.15, 1);
  const muted = $.NSColor.colorWithCalibratedWhiteAlpha(0.4, 1);
  text("安装 Toonflow", 320, 28, dark);
  text("将左侧应用拖到右侧 Applications 文件夹", 282, 17, muted);
  text("→", 165, 56, $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.25, 0.45, 0.9, 1));
  text("等待复制完成，再从“应用程序”打开 Toonflow。", 64, 15, dark);
  text("Drag Toonflow to Applications to install.", 34, 13, muted);
  image.unlockFocus;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  if (!bitmap.representationUsingTypeProperties($.NSPNGFileType, $({})).writeToFileAtomically(args[0], true)) {
    throw new Error("无法保存安装说明背景");
  }
}
`);

  const temporary = mkdtempSync(join(tmpdir(), "toonflowDmg"));
  const imagePath = join(temporary, "install.dmg");
  try {
    const createArgs = [...args];
    createArgs[formatIndex + 1] = "UDRW";
    createArgs[createArgs.length - 1] = imagePath;
    createArgs.splice(1, 0, "-fs", "HFS+");
    await run(["/usr/bin/hdiutil", ...createArgs]);
    await run(["/usr/bin/hdiutil", "attach", imagePath, "-readwrite", "-nobrowse", "-mountpoint", mountPath]);
    await run(["/usr/bin/osascript", "-", mountPath, apps[0]!], `
on run args
  set volumeFolder to POSIX file (item 1 of args) as alias
  set appName to item 2 of args
  tell application "Finder"
    tell folder volumeFolder
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set bounds of container window to {200, 160, 840, 582}
      set viewOptions to icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 96
      set text size of viewOptions to 14
      set background picture of viewOptions to file ".background:install.png"
      set position of item appName to {170, 190}
      set position of item "Applications" to {470, 190}
      close
      open
      update without registering applications
      delay 2
      close
      delay 1
    end tell
  end tell
end run
`);
    if (!existsSync(join(mountPath, ".DS_Store"))) throw new Error("Finder 未保存 macOS 安装引导布局。");
    await detachDmg(imagePath);
    await run(["/usr/bin/hdiutil", "convert", imagePath, "-format", args[formatIndex + 1]!, "-o", output, "-ov"]);
    console.log(`已添加拖拽安装引导：${basename(output)}`);
  } finally {
    try { await detachDmg(imagePath); }
    catch (error) { throw new Error(`安装镜像未能卸载，已保留临时目录：${temporary}`, { cause: error }); }
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await createDmg(process.argv.slice(2));
