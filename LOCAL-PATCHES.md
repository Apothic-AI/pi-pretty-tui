# Local fork of `pi-pretty-tui`

Fork of [`pi-pretty-tui`](https://github.com/ykn0309/pi-pretty-tui), loaded by
`~/.pi/agent/settings.json` as a `git:` package:

```
"git:github.com/Apothic-AI/pi-pretty-tui@test/composer-selection-on-apothic"
```

Pi resolves that into `~/.pi/agent/git/github.com/Apothic-AI/pi-pretty-tui`, which is the
tree this agent actually runs. A second checkout of the same repository lives at
`../../apothic-monorepo-workspace/tooling/pi-pretty-tui` (the `apothic` bookmark); it is the
integration target, not the loaded extension.

The fork exists because the npm release could not coexist with [bizzy](../bizzy) (background
tasks), which is also installed in the same agent. That specific incompatibility is fixed
upstream as of `bb5d805`, so the fork now carries features rather than a coexistence patch.

Baseline: `0.3.0` plus the upstream `bb5d805` merge (`prep/apothic-upstream-merge`), verified
on Pi 1.4.0.

## The conflict

bizzy owns the `bash` tool: it replaces Pi's definition so long-running commands can
background themselves (`run_in_background`, the auto-background timeout, Ctrl+Shift+B,
`/bg`). pretty-tui also registered a tool named `bash`.

Verified on Pi 1.4.0, the failure is *not* that the loser extension refuses to load.
`detectExtensionConflicts` in Pi's resource loader runs after every extension has loaded and
records a diagnostic per duplicate name, but `addExtensionConflictDiagnostics` explicitly
keeps all extensions loaded and lets load order decide the definition:

```js
// Keep all extensions loaded. Conflicts are reported as diagnostics,
// and precedence is handled by load order.
extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
```

The real damage is silent. `ExtensionRunner.getToolDefinition()` returns the *first*
extension's definition for a name, so when pretty-tui loads before bizzy it wins `bash`
outright and bizzy's schema disappears from what the model sees — `run_in_background` is
simply not in the tool's parameters any more, while bizzy still executes the calls. Reproduced
with a stand-in owner: pre-fix, `bash` resolved to pretty-tui's stock definition and
`run_in_background` was absent; post-fix, the owner's description and parameters survive and
pretty-tui still supplies the drawing. A `try`/`catch` around `pi.registerTool` cannot fix
this, because nothing throws.

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

Upstream supplies this now. `bb5d805` (upstream PR #3) implements the render-only mechanism
inside `registerStyledTool` itself and goes further: it marks non-builtin `sourceInfo.path`
values with `THIRD_PARTY_TOOL`, so a third-party tool stays recognisable after the renderer
resolver runs. Our own `registerRenderedTool` was the same mechanism with less scope, so it
was **retired rather than reconciled**: reverting it is precisely what makes the upstream
merge clean instead of conflicted.

Nothing in this fork patches tool registration any more. `extensions/index.ts` calls
`pi.registerToolRenderer` exactly as upstream ships it, and the fork's own patches are the
composer-selection feature (#7) and the selection frame-chrome fix (#5).

Verified against Pi 1.4.0 on the merged tree with upstream's own `tests/coexistence.mjs`
(real `loadExtensions`, no model): pretty-tui contributes renderer resolvers and **0** tools,
the stand-in owner keeps its `bash` schema and `run_in_background` parameter, and the
resolvers chain instead of colliding. `npm test` is green on the merge.

## Upgrading from npm

1. Copy the new release over this tree, keeping `LOCAL-PATCHES.md` and `tsconfig.json`:

   ```bash
   npm pack pi-pretty-tui@<version> --pack-destination /tmp
   tar xzf /tmp/pi-pretty-tui-<version>.tgz -C /tmp
   cp -R /tmp/package/extensions/. extensions/
   cp /tmp/package/package.json /tmp/package/README*.md /tmp/package/LICENSE .
   ```

2. Nothing to re-apply: a release that already contains `bb5d805` carries the render-only
   mechanism. Only re-apply the composer-selection work (#7) if the release predates it.

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
