#!/usr/bin/env node
// Мутационное тестирование серверной логики.
//
// Скрипт копирует проект во временную папку, по одному вносит туда намеренные баги
// («мутанты») и прогоняет `npm test`. Тесты должны упасть на каждом мутанте — тогда он «убит».
// Выживший мутант — это либо непокрытое тестами поведение, либо настоящий баг.
// Рабочие файлы проекта не меняются.
//
//   node tests/mutation.mjs            — все мутанты
//   node tests/mutation.mjs edit pass  — только мутанты, в описании которых есть эти слова

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Каждый мутант — правдоподобная ошибка в логике, а не синтаксический мусор. */
const MUTANTS = [
  // комната и владелец
  { file: "server/room.ts", desc: "можно создать вторую комнату", find: "if (current || pending) throw new RoomExistsError();", replace: "" },
  { file: "server/room.ts", desc: "любой пароль подходит", find: 'return Boolean(password) && safeEqual(String(password), config.roomPassword);', replace: "return true;" },
  { file: "server/room.ts", desc: "любой токен делает ведущим", find: "return Boolean(current && token && safeEqual(token, current.ownerToken));", replace: "return Boolean(current && token);" },
  { file: "server/room.ts", desc: "пустая комната не закрывается сама", find: "if (!current || count > 0) return;", replace: "if (!current || count >= 0) return;" },
  // HTTP API
  { file: "server/index.ts", desc: "вторая комната отвечает 200 вместо 409", find: "res.status(409).json({ error: err.message });", replace: "res.status(200).json({ error: err.message });" },
  { file: "server/index.ts", desc: "закрыть комнату может любой без пароля", find: "if (!isOwner(ownerToken(req))) {", replace: "if (false) {" },
  { file: "server/index.ts", desc: "нет лимита на перебор пароля", find: "if (recent.length >= 5) {", replace: "if (recent.length >= 500) {" },
  { file: "server/index.ts", desc: "лимит обходится подделкой X-Forwarded-For", find: 'req.get("x-forwarded-for")?.split(",").pop()?.trim()', replace: 'req.get("x-forwarded-for")?.split(",").shift()?.trim()' },
  { file: "server/index.ts", desc: "имя ведущего не обрезается", find: 'return String(raw ?? "").replace(/\\s+/g, " ").trim().slice(0, 32) || "Ведущий";', replace: 'return String(raw ?? "") || "Ведущий";' },
  { file: "server/index.ts", desc: "адрес без схемы не получает https://", find: "if (startUrl && !/^[a-z]+:/i.test(startUrl)) startUrl = `https://${startUrl}`;", replace: "" },
  // чат
  { file: "server/realtime.ts", desc: "длинные сообщения не обрезаются", find: 'const cleanText = (raw: unknown) => String(raw ?? "").trim().slice(0, MAX_TEXT);', replace: 'const cleanText = (raw: unknown) => String(raw ?? "").trim();' },
  { file: "server/realtime.ts", desc: "новичок не получает историю чата", find: "      history,\n      ice:", replace: "      history: [],\n      ice:" },
  { file: "server/realtime.ts", desc: "ответ без снимка цитаты", find: "...(quoted && { replyTo: { id: quoted.id, name: quoted.name, text: snippet(quoted.text) } }),", replace: "" },
  { file: "server/realtime.ts", desc: "можно править чужие сообщения", find: "if (!message || !text || message.authorUid !== self.uid || message.text === text) return;", replace: "if (!message || !text || message.text === text) return;" },
  { file: "server/realtime.ts", desc: "правка на тот же текст рассылается", find: "if (!message || !text || message.authorUid !== self.uid || message.text === text) return;", replace: "if (!message || !text || message.authorUid !== self.uid) return;" },
  { file: "server/realtime.ts", desc: "правка не обновляет цитаты в ответах", find: "reply.replyTo.text = snippet(text);", replace: "" },
  { file: "server/realtime.ts", desc: "реакции не из списка принимаются", find: "if (!message || !(MESSAGE_REACTIONS as readonly string[]).includes(msg.emoji)) return;", replace: "if (!message) return;" },
  { file: "server/realtime.ts", desc: "повторная реакция не снимается", find: "if (had !== msg.emoji) {", replace: "if (true) {" },
  { file: "server/realtime.ts", desc: "реакции копятся вместо замены", find: "const rest = list.filter((r) => r.uid !== self.uid);", replace: "const rest = list;" },
  { file: "server/realtime.ts", desc: "uid меняется при переподключении", find: 'const secret = typeof key === "string" && key.length >= 16 ? key.slice(0, 128) : randomUUID();', replace: "const secret = randomUUID();" },
  { file: "server/realtime.ts", desc: "uid — это сам секретный ключ", find: 'return createHash("sha256").update(secret).digest("base64url").slice(0, 16);', replace: "return secret;" },
  // права и сигнализация
  { file: "server/realtime.ts", desc: "гость может менять права", find: 'if (!client.isHost) return send(client, { t: "error", message: "Только ведущий может менять права" });', replace: "" },
  { file: "server/realtime.ts", desc: "сигнализация уходит всем, а не адресату", find: 'if (target?.participant) send(target, { t: "signal", from: id, data: msg.data });', replace: 'broadcast({ t: "signal", from: id, data: msg.data }, id);' },
  { file: "server/realtime.ts", desc: "нет ограничения частоты летящих реакций", find: "if (now - client.lastReactionAt < 250) return;", replace: "" },
  { file: "server/realtime.ts", desc: "уход участника не запускает таймер пустой комнаты", find: "        if (client.participant) broadcast({ t: \"left\", id });\n        setOccupancy(participants().length);", replace: "        if (client.participant) broadcast({ t: \"left\", id });" },
  // туннели
  { file: "server/tunnel.ts", desc: "адрес Cloudflare объявляется до регистрации соединения", find: "return candidate && /Registered tunnel connection/i.test(text) ? candidate : null;", replace: "return candidate;" },
  { file: "server/tunnel.ts", desc: "нет подсказки «разреши Funnel»", find: "if (enable) setHint(`Разреши Funnel для этой машины (один раз): ${enable[0]}`);", replace: "" },
  { file: "server/tunnel.ts", desc: "туннель не закрывается вместе с сервером", find: '  child?.kill("SIGTERM");\n  child = null;\n}', replace: "  child = null;\n}" },
  { file: "server/tunnel.ts", desc: "упавший туннель не перезапускается", find: 'if (stopped || state === "missing") return;', replace: "return;" },
  { file: "server/tunnel.ts", desc: "свой адрес не теряет слеш в конце", find: 'setUrl(mode.replace(/\\/$/, ""));', replace: "setUrl(mode);" },
];

const filter = process.argv.slice(2).map((s) => s.toLowerCase());
const selected = MUTANTS.filter((m) => !filter.length || filter.some((f) => m.desc.toLowerCase().includes(f)));

const work = mkdtempSync(join(tmpdir(), "ls-mutation-"));
for (const dir of ["server", "shared", "tests"]) cpSync(join(ROOT, dir), join(work, dir), { recursive: true });
for (const file of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, file), join(work, file));
symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"));

const runTests = () => {
  const run = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--test", "--test-reporter=dot", ...["server", "tunnel"].map((n) => `tests/${n}.test.ts`)], {
    cwd: work,
    encoding: "utf8",
    timeout: 120_000,
  });
  // Если мутант подвесил тесты и их убили по таймауту, их серверы и заглушки туннелей
  // остались бы жить — подчищаем всё, что запущено из временной копии.
  spawnSync("pkill", ["-f", work]);
  spawnSync("pkill", ["-f", "ls-tunnel-"]);
  return run;
};

console.log(`Мутационное тестирование: ${selected.length} мутантов\n`);
const baseline = runTests();
if (baseline.status !== 0) {
  console.error("Тесты падают и без мутаций — сначала почини их.\n" + baseline.stdout + baseline.stderr);
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

const results = [];
for (const m of selected) {
  const path = join(work, m.file);
  const original = readFileSync(path, "utf8");
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    results.push({ ...m, verdict: "не применился", note: `фрагмент найден ${count} раз` });
    console.log(`  ?  ${m.desc} — фрагмент найден ${count} раз`);
    continue;
  }
  writeFileSync(path, original.replace(m.find, m.replace));
  const started = Date.now();
  const run = runTests();
  writeFileSync(path, original);
  const killed = run.status !== 0;
  results.push({ ...m, verdict: killed ? "убит" : "ВЫЖИЛ" });
  console.log(`  ${killed ? "✔" : "✖"}  ${m.desc}  (${((Date.now() - started) / 1000).toFixed(1)} с)`);
}
rmSync(work, { recursive: true, force: true });

const applied = results.filter((r) => r.verdict !== "не применился");
const killed = applied.filter((r) => r.verdict === "убит").length;
console.log(`\nУбито ${killed} из ${applied.length} (${Math.round((killed / Math.max(1, applied.length)) * 100)}%)`);
const survivors = applied.filter((r) => r.verdict === "ВЫЖИЛ");
if (survivors.length) {
  console.log("Выжили:");
  survivors.forEach((s) => console.log(`  — ${s.desc} (${s.file})`));
}
process.exit(survivors.length || results.some((r) => r.verdict === "не применился") ? 1 : 0);
