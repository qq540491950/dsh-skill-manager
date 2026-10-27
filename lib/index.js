/**
 * 本文件由 `tools/build.ts` 从 `src/host/index.ts` 生成 —— **不要直接编辑**。
 * 设计说明（为什么零 import、为什么必须带 scope 读、为什么要有根目录直读兜底）
 * 见 src/host/index.ts 与 README.md。
 */

// src/host/index.ts
var ROUTE = "/api/skill-manager";
var CONTENT_LIMIT = 2e5;
var RESOLVE_TIMEOUT_MS = 8e3;
var SCAN_ENTRY_LIMIT = 200;
var SCAN_READ_LIMIT = 65536;
var SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var GROUPS = {
  "project-dsh": "project",
  "project-agents": "project",
  "user-dsh": "global",
  "user-agents": "global",
  custom: "custom",
  bundled: "bundled",
  runtime: "bundled"
};
var GROUP_ORDER = ["project", "global", "custom", "bundled", "other"];
var name = "dsh-skill-manager";
var inject = [];
function apply(ctx) {
  ctx.inject(["connection", "skills"], (scope) => {
    const service = (serviceName) => scope.get(serviceName);
    const defaultPresetId = async () => {
      const presets = service("agentPresets");
      if (presets === void 0) return void 0;
      try {
        const preset = await presets.resolve();
        if (typeof preset?.id === "string" && preset.id !== "") return preset.id;
      } catch {
      }
      try {
        const roster = await presets.remoteExportList();
        const rows = Array.isArray(roster?.presets) ? roster.presets : [];
        const picked = rows.find((row) => row?.isDefault === true) ?? rows[0];
        return typeof picked?.id === "string" && picked.id !== "" ? picked.id : void 0;
      } catch {
        return void 0;
      }
    };
    const fallbackCwd = () => {
      try {
        const workspaces = service("workspaceRegistry")?.list?.();
        const first = Array.isArray(workspaces) ? workspaces[0] : void 0;
        return typeof first?.path === "string" && first.path !== "" ? first.path : void 0;
      } catch {
        return void 0;
      }
    };
    const observeSession = async (sessionId, signal) => {
      const sessionQuery = service("sessionQuery");
      if (typeof sessionQuery?.observeSession !== "function") return void 0;
      try {
        return await sessionQuery.observeSession(sessionId, { signal });
      } catch {
        return void 0;
      }
    };
    const releaseLease = async (lease) => {
      if (lease === null || lease === void 0) return;
      const symbols = Symbol;
      const asyncDispose = symbols.asyncDispose;
      const dispose = symbols.dispose;
      const keyed = lease;
      try {
        const asyncRelease = asyncDispose === void 0 ? void 0 : keyed[asyncDispose];
        const syncRelease = dispose === void 0 ? void 0 : keyed[dispose];
        if (typeof asyncRelease === "function") {
          await asyncRelease.call(lease);
        } else if (typeof syncRelease === "function") {
          ;
          syncRelease.call(lease);
        }
      } catch {
      }
    };
    const joinPath = (base, ...parts) => [base.replace(/[\\/]+$/, ""), ...parts].join(base.includes("\\") ? "\\" : "/");
    const parentPath = (value) => {
      const normalized = value.replace(/[\\/]+$/, "");
      const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
      if (cut < 0) return normalized;
      if (cut === 0) return normalized.slice(0, 1);
      if (/^[A-Za-z]:$/.test(normalized.slice(0, cut))) return `${normalized.slice(0, cut)}\\`;
      return normalized.slice(0, cut);
    };
    const homeDir = () => process.env.USERPROFILE ?? process.env.HOME ?? void 0;
    const pathExists = async (path) => {
      if (typeof path !== "string" || path === "") return void 0;
      const fsService = service("fs");
      if (typeof fsService?.lstat !== "function") return void 0;
      try {
        const info = await fsService.lstat(path);
        return info !== void 0 && info !== null;
      } catch {
        return void 0;
      }
    };
    const resolveProjectRoot = async (cwd) => {
      if (typeof cwd !== "string" || cwd === "") return void 0;
      let current = cwd.replace(/[\\/]+$/, "");
      for (let depth = 0; depth < 12; depth++) {
        if (await pathExists(joinPath(current, ".git")) === true) return current;
        const parent = parentPath(current);
        if (parent === current) break;
        current = parent;
      }
      return current;
    };
    const standardRoots = async (cwd) => {
      const projectRoot = await resolveProjectRoot(cwd);
      const home = homeDir();
      const dshHome = process.env.DSH_HOME ?? (home === void 0 ? void 0 : joinPath(home, ".dsh"));
      const agentsHome = process.env.DSH_AGENTS_HOME ?? (home === void 0 ? void 0 : joinPath(home, ".agents"));
      return {
        projectRoot,
        specs: [
          {
            group: "project",
            source: "project-dsh",
            path: projectRoot === void 0 ? void 0 : joinPath(projectRoot, ".dsh", "skills")
          },
          {
            group: "project",
            source: "project-agents",
            path: projectRoot === void 0 ? void 0 : joinPath(projectRoot, ".agents", "skills")
          },
          {
            group: "global",
            source: "user-dsh",
            path: dshHome === void 0 ? void 0 : joinPath(dshHome, "skills"),
            skipSystem: true
          },
          {
            group: "global",
            source: "user-agents",
            path: agentsHome === void 0 ? void 0 : joinPath(agentsHome, "skills")
          }
        ]
      };
    };
    const probeRoots = async (standard) => {
      const rows = [];
      for (const spec of standard.specs) {
        rows.push({ group: spec.group, source: spec.source, path: spec.path, exists: await pathExists(spec.path) });
      }
      rows.push({ group: "custom", source: "custom", note: "由 Config.customSkillDirs 决定" });
      rows.push({ group: "bundled", source: "bundled", note: "随包分发 / 运行时注册" });
      return { projectRoot: standard.projectRoot, rows };
    };
    const listDirViaFs = async (path, signal) => {
      const fsService = service("fs");
      if (typeof path !== "string" || path === "") return void 0;
      if (typeof fsService?.resolve !== "function" || typeof fsService?.listDir !== "function") return void 0;
      try {
        const target = await fsService.resolve(path, { signal });
        const entries = await fsService.listDir(target, signal);
        return Array.isArray(entries) ? entries : void 0;
      } catch {
        return void 0;
      }
    };
    const readTextViaFs = async (path, signal) => {
      const fsService = service("fs");
      if (typeof path !== "string" || path === "") return void 0;
      if (typeof fsService?.resolve !== "function" || typeof fsService?.readText !== "function") return void 0;
      try {
        const target = await fsService.resolve(path, { signal });
        if (typeof fsService.stat === "function") {
          const info = await fsService.stat(target, signal);
          if (info !== void 0 && info?.type !== "file") return void 0;
        }
        const text = await fsService.readText(target, signal);
        return typeof text === "string" ? text : void 0;
      } catch {
        return void 0;
      }
    };
    const stripYamlComment = (value) => {
      const matched = /(^|\s)#/.exec(value);
      if (matched === null || matched.index === void 0) return value;
      return value.slice(0, matched.index).trimEnd();
    };
    const yamlScalar = (value) => {
      const trimmed = value.trim();
      if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/''/g, "'");
      }
      return stripYamlComment(trimmed);
    };
    const parseFrontmatter = (raw) => {
      const firstLineEnd = raw.indexOf("\n");
      if (firstLineEnd < 0) return void 0;
      if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
      const lines = [];
      let lineStart = firstLineEnd + 1;
      let closed = false;
      while (lineStart <= raw.length) {
        const nextNewline = raw.indexOf("\n", lineStart);
        const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
        const line = raw.slice(lineStart, lineEnd).replace(/\r$/, "");
        if (line === "---") {
          closed = true;
          break;
        }
        lines.push(line);
        if (nextNewline < 0) break;
        lineStart = nextNewline + 1;
      }
      if (!closed) return void 0;
      const data = {};
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line === void 0) continue;
        if (line === "" || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const key = line.slice(0, colon).trim();
        if (key === "") continue;
        const rawValue = line.slice(colon + 1).trim();
        if (/^[|>][-+]?\d*$/.test(rawValue)) {
          const block = [];
          let cursor = index + 1;
          while (cursor < lines.length) {
            const candidate = lines[cursor];
            if (candidate === void 0) break;
            if (candidate.trim() !== "" && !/^\s/.test(candidate)) break;
            block.push(candidate);
            cursor += 1;
          }
          while (block.length > 0 && (block.at(-1) ?? "").trim() === "") block.pop();
          let indent;
          for (const item of block) {
            if (item.trim() === "") continue;
            const width = item.length - item.trimStart().length;
            if (indent === void 0 || width < indent) indent = width;
          }
          const body = block.map((item) => indent === void 0 ? item : item.slice(indent));
          data[key] = rawValue.startsWith(">") ? body.join(" ").trim() : body.join("\n").trim();
          index = cursor - 1;
          continue;
        }
        data[key] = yamlScalar(rawValue);
      }
      return data;
    };
    const frontmatterBoolean = (data, key) => {
      if (!Object.hasOwn(data, key)) return { ok: true, value: void 0 };
      const value = data[key];
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "1") return { ok: true, value: true };
      if (value === "0") return { ok: true, value: false };
      if (typeof value === "string") {
        const lowered = value.toLowerCase();
        if (lowered === "true" || lowered === "yes" || lowered === "on") return { ok: true, value: true };
        if (lowered === "false" || lowered === "no" || lowered === "off") return { ok: true, value: false };
      }
      return { ok: false, value: void 0 };
    };
    const parseSkillFile = (raw, locator, root) => {
      const data = parseFrontmatter(raw);
      if (data === void 0) return void 0;
      const name2 = typeof data.name === "string" ? data.name.trim() : "";
      if (name2 === "" || !SKILL_NAME.test(name2)) return void 0;
      const description = typeof data.description === "string" ? data.description.trim() : "";
      if (description === "") return void 0;
      if (Object.hasOwn(data, "disableModelInvocation") || Object.hasOwn(data, "modelInvocable")) return void 0;
      if (Object.hasOwn(data, "userInvocable")) return void 0;
      const disableModel = frontmatterBoolean(data, "disable-model-invocation");
      const userInvocable = frontmatterBoolean(data, "user-invocable");
      if (!disableModel.ok || !userInvocable.ok) return void 0;
      const whenToUse = typeof data.whenToUse === "string" ? data.whenToUse.trim() : "";
      return {
        name: name2,
        description,
        ...whenToUse === "" ? {} : { whenToUse },
        invocation: { modelInvocable: disableModel.value !== true, userInvocable: userInvocable.value !== false },
        source: root.source,
        provider: "filesystem",
        resourceBase: { kind: "directory", path: locator.directory },
        path: locator.path
      };
    };
    const scanRoot = async (spec, signal) => {
      const entries = await listDirViaFs(spec.path, signal);
      if (entries === void 0) return [];
      const found = [];
      for (const entry of entries.slice(0, SCAN_ENTRY_LIMIT)) {
        const entryName = typeof entry?.name === "string" ? entry.name : "";
        if (entryName === "") continue;
        if (spec.skipSystem === true && entryName === ".system") continue;
        const base = spec.path ?? "";
        const display = typeof entry?.target?.displayPath === "string" ? entry.target.displayPath : joinPath(base, entryName);
        const locator = entry.type === "directory" ? { path: joinPath(display, "SKILL.md"), directory: display } : entry.type === "file" && entryName.endsWith(".md") ? { path: display, directory: base } : void 0;
        if (locator === void 0) continue;
        const raw = await readTextViaFs(locator.path, signal);
        if (raw === void 0) continue;
        const parsed = parseSkillFile(raw.slice(0, SCAN_READ_LIMIT), locator, spec);
        if (parsed !== void 0) found.push(parsed);
      }
      found.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      return found;
    };
    const scanRoots = async (standard, signal) => {
      const out = [];
      for (const spec of standard.specs) {
        for (const skill of await scanRoot(spec, signal)) out.push(skill);
      }
      return out;
    };
    const resolveView = async (options, signal) => {
      const agents = service("agents");
      const presets = service("agentPresets");
      const sessionId = typeof options.sessionId === "string" && options.sessionId !== "" ? options.sessionId : void 0;
      const observation = sessionId === void 0 ? void 0 : await observeSession(sessionId, signal);
      const header = observation?.header;
      const recordedPreset = typeof header?.agentPreset === "string" && header.agentPreset !== "" ? header.agentPreset : typeof observation?.projections?.values?.agentPreset === "string" ? observation.projections.values.agentPreset : void 0;
      const cwd = options.cwd ?? (typeof header?.cwd === "string" && header.cwd !== "" ? header.cwd : void 0) ?? fallbackCwd();
      const preset = options.preset ?? recordedPreset;
      const live = sessionId === void 0 ? void 0 : agents?.get?.(sessionId);
      if (live !== void 0) {
        const scoped = presets?.serviceFor?.(live, "skills");
        return {
          registry: scoped ?? scope.skills,
          scope: live,
          cwd,
          presetId: safePresetOf(presets, live) ?? preset,
          resolvedBy: "session-agent",
          lease: void 0,
          observation
        };
      }
      if (presets !== void 0) {
        const presetId = preset ?? await defaultPresetId();
        try {
          const lease = await presets.acquireScope(presetId);
          if (lease !== void 0 && lease?.key !== void 0) {
            return {
              registry: scope.skills,
              scope: lease.key,
              cwd,
              presetId,
              resolvedBy: "preset-lease",
              lease,
              observation
            };
          }
        } catch {
        }
      }
      return {
        registry: scope.skills,
        scope: void 0,
        cwd,
        presetId: void 0,
        resolvedBy: "global-layer",
        lease: void 0,
        observation
      };
    };
    const withView = async (options, signal, operation) => {
      const view = await resolveView(options, signal);
      try {
        return await operation(view);
      } finally {
        await releaseLease(view.observation);
        await releaseLease(view.lease);
      }
    };
    const toRow = (skill, index) => {
      const source = typeof skill?.source === "string" ? skill.source : "unknown";
      return {
        index,
        name: String(skill?.name ?? ""),
        description: String(skill?.description ?? ""),
        whenToUse: typeof skill?.whenToUse === "string" ? skill.whenToUse : void 0,
        path: typeof skill?.path === "string" ? skill.path : void 0,
        source,
        group: GROUPS[source] ?? "other",
        provider: typeof skill?.provider === "string" ? skill.provider : void 0,
        modelInvocable: skill?.invocation?.modelInvocable !== false,
        userInvocable: skill?.invocation?.userInvocable !== false,
        resourceKind: typeof skill?.resourceBase?.kind === "string" ? skill.resourceBase.kind : void 0
      };
    };
    const readCatalog = (options, signal) => withView(options, signal, async (view) => {
      const standard = await standardRoots(view.cwd);
      const [snapshot, scanned] = await Promise.all([
        view.registry.snapshot({ cwd: view.cwd, scope: view.scope, signal }),
        scanRoots(standard, signal)
      ]);
      const rows = (Array.isArray(snapshot?.skills) ? snapshot.skills : []).map(toRow);
      const seen = new Set(rows.map((row) => row.name));
      for (const skill of scanned) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        rows.push(toRow(skill, rows.length));
      }
      rows.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const [index, row] of rows.entries()) row.index = index;
      const counts = {};
      for (const group of GROUP_ORDER) counts[group] = 0;
      for (const row of rows) counts[row.group] = (counts[row.group] ?? 0) + 1;
      const providers = {};
      for (const row of rows) {
        const key = row.provider ?? "(未知提供方)";
        providers[key] = (providers[key] ?? 0) + 1;
      }
      let roots = { projectRoot: standard.projectRoot, rows: [] };
      try {
        roots = await probeRoots(standard);
      } catch {
      }
      return {
        skills: rows,
        counts,
        providers,
        roots: roots.rows,
        projectRoot: roots.projectRoot,
        complete: snapshot?.complete !== false,
        resolvedBy: view.resolvedBy,
        presetId: view.presetId,
        cwd: view.cwd
      };
    });
    const readSkill = (options, signal) => withView(options, signal, async (view) => {
      const name2 = String(options.name ?? "");
      const found = await view.registry.get(name2, {
        cwd: view.cwd,
        scope: view.scope,
        signal
      });
      if (found !== void 0) {
        const content = String(found.content ?? "");
        return {
          name: String(found.name ?? ""),
          path: typeof found.path === "string" ? found.path : void 0,
          content: content.slice(0, CONTENT_LIMIT),
          truncated: content.length > CONTENT_LIMIT,
          contentLength: content.length
        };
      }
      const standard = await standardRoots(view.cwd);
      for (const spec of standard.specs) {
        const match = (await scanRoot(spec, signal)).find((skill) => skill.name === name2);
        if (match === void 0) continue;
        const raw = await readTextViaFs(match.path, signal);
        if (raw === void 0) continue;
        return {
          name: name2,
          path: match.path,
          content: raw.slice(0, CONTENT_LIMIT),
          truncated: raw.length > CONTENT_LIMIT,
          contentLength: raw.length
        };
      }
      throw new Error(`当前视图里找不到 skill "${name2}"；它可能刚被改名或删除，请刷新后重试`);
    });
    const respond = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
    const handler = async (request) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
      try {
        const url = new URL(request.url);
        const options = {
          sessionId: url.searchParams.get("sessionId") ?? void 0,
          preset: url.searchParams.get("preset") ?? void 0,
          cwd: url.searchParams.get("cwd") ?? void 0
        };
        if (request.method === "GET") {
          const data = await readCatalog(options, controller.signal);
          return respond(200, {
            ok: true,
            data: { ...data, route: ROUTE, capabilities: ["snapshot", "read"] }
          });
        }
        const payload = await request.json();
        switch (payload?.op) {
          case "read": {
            const data = await readSkill(
              {
                ...options,
                name: payload.name,
                sessionId: typeof payload.sessionId === "string" ? payload.sessionId : options.sessionId,
                cwd: typeof payload.cwd === "string" ? payload.cwd : options.cwd
              },
              controller.signal
            );
            return respond(200, { ok: true, data });
          }
          default:
            return respond(400, { ok: false, error: `未知操作：${String(payload?.op)}` });
        }
      } catch (error) {
        return respond(409, { ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
      }
    };
    scope.connection.fetch.register({
      path: ROUTE,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: handler
    });
  });
}
function safePresetOf(presets, agent) {
  try {
    const id = presets?.composedPreset?.(agent?.ctx);
    return typeof id === "string" ? id : void 0;
  } catch {
    return void 0;
  }
}
export {
  apply,
  inject,
  name
};
