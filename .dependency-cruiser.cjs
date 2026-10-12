/** Architecture rules (docs/architecture.md §1.2). */
module.exports = {
  forbidden: [
    {
      name: 'core-no-framework',
      comment: 'core is framework-agnostic: no next or react',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: 'node_modules/(next|react|react-dom)/' },
    },
    {
      name: 'modules-no-core',
      comment: 'modules receive services through ctx and never import core',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^packages/core/' },
    },
    {
      name: 'worker-no-ui',
      comment: 'the worker must never pull UI code',
      severity: 'error',
      from: { path: '^apps/worker/' },
      to: { path: '(^packages/ui/|^modules/[^/]+/src/ui|node_modules/(react|next)/)' },
    },
    {
      name: 'packages-no-apps',
      severity: 'error',
      from: { path: '^(packages|modules)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: { path: '^(packages|modules)/' },
      to: { circular: true, pathNot: 'generated' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(generated|\\.next|dist)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
