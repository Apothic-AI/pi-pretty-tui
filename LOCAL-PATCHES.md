# Local fork of `pi-pretty-tui`

Vendored copy of [`pi-pretty-tui`](https://github.com/ykn0309/pi-pretty-tui), forked from
`0.3.0`. It has been installed two ways, and the distinction matters before you test it:

- **What pi actually loads** is a git branch: `~/.pi/agent/settings.json` names
  `git:github.com/Apothic-AI/pi-pretty-tui@test/composer-selection-on-apothic`, which pi
  checks out into `~/.pi/agent/git/github.com/Apothic-AI/pi-pretty-tui`. Change that branch
  to change what runs.
- **The monorepo vendored tree** is
  `../../Code/apothic-monorepo-workspace/tooling/pi-pretty-tui`, a jj colocate clone. While
  the settings line above is in force, this tree is *not* what pi loads.

It exists because the npm release cannot coexist with
[bizzy](../bizzy) (background tasks), which is also installed in the same agent.

Current base: `0.3.0` (the release whose development baseline is Pi 1.3.0). It loads and
renders on Pi 1.4.0, which is what this agent runs.

## The conflict

bizzy owns the `bash` tool: it replaces Pi's definition so long-running commands can
background themselves (`run_in_background`, the auto-background timeout, Ctrl+Shift+B,
`/bg`). pretty-tui also registered a tool named `bash`.

**Corrected 2026-11-01.** An earlier revision of this section claimed the collision was
silent — that Pi kept every extension loaded, filed the duplicate as a *diagnostic*, and let
load order quietly pick a winner. That was wrong, and it was wrong in both directions; it
came from trusting a source comment instead of the line underneath it. Measured against Pi
1.4.0's own loader:

**It is loud.** `addExtensionConflictDiagnostics` still carries the comment *"Conflicts are
reported as diagnostics"*, but its loop body pushes into the error list:

```js
// Keep all extensions loaded. Conflicts are reported as diagnostics,
// and precedence is handled by load order.
extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
```

Pi's CLI formats each entry as `Failed to load extension "<path>": <error>`, so what the
operator sees is `Failed to load extension "…": Tool "bash" conflicts with "…"`. Loading two
fixture extensions that both register `bash` reproduces it exactly: both appear in
`extensions`, one `Tool "bash" conflicts with <owner path>` entry appears in `errors`, and the
diagnostics list stays empty.

**It is not fatal either.** Both extensions stay loaded; nothing is unloaded and the rival's
`registerTool` does not throw — which is also why a `try`/`catch` around `pi.registerTool`
cannot intercept it. There is nothing to catch.

**But the precedence is real, and the damage is still schema loss.** The *first* registration
wins outright: with two fixtures registering `bash`, the resolved tool carries the first one's
label and parameters and the second one's are gone. So when pretty-tui loads before bizzy it
wins `bash` and `run_in_background` is absent from the parameters the model sees, while bizzy
keeps executing the calls — the same harm as before, now announced by an extension error
instead of hidden behind one. Reproduced with a stand-in owner: pre-fix, `bash` resolved to
pretty-tui's stock definition with `run_in_background` absent; post-fix, the owner's
description and parameters survive and pretty-tui still supplies the drawing.

## The change

Every built-in tool pretty-tui renders is **render-only**. `pi.registerToolRenderer` composes
instead of competing: resolvers run in extension load order, `next()` chains to the remaining
resolvers and finally to whichever extension owns the tool, and Pi's interactive mode feeds
the resolved object straight into `ToolExecutionComponent`. So claiming one tool name changes
only how that tool draws:

- pretty-tui registers **zero** tools, so it can never take a name from another extension;
- `bash` still renders pretty (`renderShell: "self"`) while bizzy's schema, description,
  prompt guidelines, and execution are untouched;
- every other tool resolves exactly as before.

Two pieces, both in `extensions/index.ts`:

1. A helper above `export default function prettyTui`:

   ```ts
   function registerRenderedTool(pi: ExtensionAPI, tool: { name?: string }, renderers: ToolRenderers): void {
     const toolName = tool.name;
     if (!toolName) throw new Error("registerRenderedTool needs a named tool definition");
     pi.registerToolRenderer((name, next) =>
       name === toolName ? { ...next(), ...renderers } : next(),
     );
   }
   ```

   The `{ ...next(), ...renderers }` merge is required, not cosmetic: the resolver's return
   value *is* the definition Pi renders with, so returning our renderers alone drops the
   owner's `name`, `description`, `parameters`, `label`, and any extra fields.

2. Upstream `0.3.0` funnels all seven built-ins (`read`, `bash`, `edit`, `write`, `grep`,
   `find`, `ls`) through one `registerStyledTool(definition)` helper, so the patch is a
   single call site: its `pi.registerTool({ ...definition, renderCall, renderResult })`
   becomes

   ```ts
   registerRenderedTool(pi, definition, {
     ...(definition.renderShell ? { renderShell: definition.renderShell } : {}),
     renderCall: (...args: any[]) => select("renderCall", args),
     renderResult: (...args: any[]) => select("renderResult", args),
   });
   ```

   `ToolRenderers` is `Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">`,
   so the native/pretty `select()` swap keeps working unchanged.

The `0.2.8` base needed the same helper wired into seven separate call sites; `0.3.0`'s
refactor into `registerStyledTool` collapsed them into one, so this patch is now smaller than
it was.

### Status: upstream has adopted this, so the fork should retire it

Upstream `main` now carries the same mechanism, merged as
[#3](https://github.com/ykn0309/pi-pretty-tui/pull/3) (`bb5d805`, "Avoid conflicts with
replacement tools"). Its version goes slightly further: it also marks a tool whose
`sourceInfo.path` is not `builtin:<name>` with `THIRD_PARTY_TOOL`, so a same-named extension
tool keeps its own rendering *and* its own parameters. Two consequences:

- **PR #4 is superseded, not competing.** #3 landed upstream first; there is no reason to
  carry a second implementation.
- **Keeping both is what makes the merge conflict.** `apothic` merges cleanly with
  `upstream/main` only after `428a0ac` ("Register tool renderers instead of claiming built-in
  tool names") is reverted; with it in place, `extensions/index.ts` and
  `tests/regression.mjs` conflict. Once upstream's version is in the tree, delete
  `registerRenderedTool` and let upstream's `registerToolRenderer` call stand.

Verified against Pi 1.4.0 by loading both extensions through Pi's real `loadExtensions()`:
pretty-tui contributes 7 renderer resolvers and **0** tools, bizzy keeps
`bash`, `bash_bg`, `jobs`, `agent_bg`, `monitor`, `detectExtensionConflicts` reports nothing,
and `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` resolve to pretty-tui renderers with
`renderShell: self` while `codemode` and everything else falls through to its owner.

## Upgrading from npm

1. Copy the new release over this tree, keeping `LOCAL-PATCHES.md` and `tsconfig.json`:

   ```bash
   npm pack pi-pretty-tui@<version> --pack-destination /tmp
   tar xzf /tmp/pi-pretty-tui-<version>.tgz -C /tmp
   cp -R /tmp/package/extensions/. extensions/
   cp /tmp/package/package.json /tmp/package/README*.md /tmp/package/LICENSE .
   ```

2. Re-apply the patch: add `type ToolRenderers` to the `@earendil-works/pi-coding-agent`
   import, add the `registerRenderedTool` helper above `export default function prettyTui`,
   and swap the `pi.registerTool(...)` call inside `registerStyledTool` for
   `registerRenderedTool(...)` as shown above. If a release ever reintroduces a direct
   `pi.registerTool` for one of the seven built-ins, convert that call site the same way.
   **Check first:** a release built on upstream `bb5d805` or later already registers through
   `pi.registerToolRenderer`, and step 2 is then a no-op — carrying this fork's helper on top
   of it is a duplicate patch.

3. Typecheck. The npm tarball ships no `tsconfig.json` and no `node_modules`, so this
   vendored copy carries its own `tsconfig.json` and `tsc` needs the Pi packages plus
   `@types/node` on its resolution path. Point a throwaway install at it and remove the
   link afterwards:

   ```bash
   npm i --prefix /tmp/pt-typecheck @types/node@22 typescript \
     @earendil-works/pi-coding-agent@<host pi version> @earendil-works/pi-tui@<host pi version>
   ln -sfn /tmp/pt-typecheck/node_modules node_modules
   /home/bitnom/.local/share/pnpm/tsc -p tsconfig.json   # or npx tsc
   rm -f node_modules
   ```

   `npm test` in `package.json` is upstream's script and references `tests/regression.mjs`,
   which the npm tarball does not ship; run it from an upstream checkout instead. Then start
   `pi` and confirm both extensions load with no `extension_error`.
