// A dependency-free stand-in for the `figma` global. It keeps the semantics the
// sandbox depends on: `mixed` is a symbol, a type only has the properties Figma's
// typings give it, getters can throw, and `postMessage` rejects what cannot be cloned.

type Surface = Record<string, unknown>;

const styleIds = (...keys: string[]): Surface => Object.fromEntries(keys.map((key) => [key, '']));

const CORE: Surface = {
  visible: true,
  locked: false,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  boundVariables: {},
  exportSettings: [],
  reactions: [],
  explicitVariableModes: {},
};
const BLEND: Surface = { blendMode: 'PASS_THROUGH', isMask: false, opacity: 1 };
const PAINTED: Surface = {
  fills: [],
  strokes: [],
  strokeWeight: 0,
  strokeAlign: 'INSIDE',
  strokeCap: 'NONE',
  dashPattern: [],
};
const EFFECTS: Surface = { effects: [] };
const CHILD_LAYOUT: Surface = {
  layoutAlign: 'INHERIT',
  layoutGrow: 0,
  layoutSizingHorizontal: 'FIXED',
  layoutSizingVertical: 'FIXED',
  layoutPositioning: 'AUTO',
  rotation: 0,
};
const CONTAINER_LAYOUT: Surface = {
  layoutMode: 'NONE',
  layoutWrap: 'NO_WRAP',
  primaryAxisSizingMode: 'AUTO',
  counterAxisSizingMode: 'FIXED',
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  itemSpacing: 0,
  counterAxisSpacing: 0,
  paddingLeft: 0,
  paddingRight: 0,
  paddingTop: 0,
  paddingBottom: 0,
  clipsContent: true,
  layoutGrids: [],
};
const CONSTRAINTS: Surface = { constraints: { horizontal: 'MIN', vertical: 'MIN' } };
const CORNERS: Surface = { cornerRadius: 0, topLeftRadius: 0 };
const PUBLISHABLE: Surface = { key: '', description: '', remote: false };

const FRAME: Surface = {
  ...BLEND,
  ...PAINTED,
  ...EFFECTS,
  ...CHILD_LAYOUT,
  ...CONTAINER_LAYOUT,
  ...CONSTRAINTS,
  ...CORNERS,
  backgrounds: [],
  ...styleIds('effectStyleId', 'fillStyleId', 'gridStyleId', 'strokeStyleId'),
};
const LINE: Surface = {
  ...BLEND,
  ...PAINTED,
  ...EFFECTS,
  ...CHILD_LAYOUT,
  ...CONSTRAINTS,
  ...styleIds('effectStyleId', 'fillStyleId', 'strokeStyleId'),
};
const SHAPE: Surface = { ...LINE, ...CORNERS };
const VECTOR: Surface = { ...SHAPE, vectorPaths: [], vectorNetwork: {}, fillGeometry: [] };
const MINIMAL_FILL: Surface = {
  blendMode: 'PASS_THROUGH',
  opacity: 1,
  fills: [],
  ...styleIds('fillStyleId'),
};
const STROKED: Surface = {
  blendMode: 'PASS_THROUGH',
  opacity: 1,
  rotation: 0,
  cornerRadius: 0,
  strokes: [],
  strokeWeight: 0,
  strokeAlign: 'CENTER',
  ...styleIds('strokeStyleId'),
};

const SURFACES = {
  FRAME,
  COMPONENT: {
    ...FRAME,
    ...PUBLISHABLE,
    componentPropertyDefinitions: {},
    variantProperties: null,
  },
  COMPONENT_SET: {
    ...FRAME,
    ...PUBLISHABLE,
    componentPropertyDefinitions: {},
    variantGroupProperties: {},
  },
  INSTANCE: { ...FRAME, componentProperties: {}, variantProperties: null, overrides: [] },
  GROUP: { ...BLEND, ...EFFECTS, ...CHILD_LAYOUT, backgrounds: [], ...styleIds('effectStyleId') },
  SECTION: {
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: 'INSIDE',
    cornerRadius: 0,
    ...styleIds('fillStyleId', 'strokeStyleId'),
  },
  BOOLEAN_OPERATION: {
    ...BLEND,
    ...PAINTED,
    ...EFFECTS,
    ...CHILD_LAYOUT,
    ...CORNERS,
    booleanOperation: 'UNION',
    ...styleIds('effectStyleId', 'fillStyleId', 'strokeStyleId'),
  },
  VECTOR,
  RECTANGLE: SHAPE,
  ELLIPSE: SHAPE,
  POLYGON: SHAPE,
  STAR: SHAPE,
  LINE,
  TEXT: {
    ...LINE,
    characters: '',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: { value: 0, unit: 'PIXELS' },
    lineHeight: { unit: 'AUTO' },
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'TOP',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    paragraphSpacing: 0,
    paragraphIndent: 0,
    ...styleIds('textStyleId'),
  },
  SLICE: CHILD_LAYOUT,
  STICKY: MINIMAL_FILL,
  TABLE: MINIMAL_FILL,
  SHAPE_WITH_TEXT: { ...STROKED, fills: [], ...styleIds('fillStyleId') },
  CONNECTOR: STROKED,
} satisfies Record<string, Surface>;

export type FakeNodeType = keyof typeof SURFACES;

const CONTAINERS: ReadonlySet<string> = new Set([
  'FRAME',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'GROUP',
  'SECTION',
  'BOOLEAN_OPERATION',
]);

const DEFAULT_RENDERS = {
  SVG: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  PNG: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

type TextRun = {
  characters: string;
  start: number;
  end: number;
  textStyleId?: string;
  fillStyleId?: string;
};

export type NodeSpec = {
  id?: string;
  name?: string;
  children?: BaseNode[];
  /** INSTANCE only: what `getMainComponentAsync` settles to. */
  main?: ComponentNode | null | Error;
  /** TEXT only: what `getStyledTextSegments` returns or throws. */
  segments?: TextRun[] | Error;
  /** What `exportAsync` returns or rejects with, per format. */
  renders?: { SVG?: Uint8Array | Error; PNG?: Uint8Array | Error };
  /** Properties whose getter throws. */
  throwing?: string[];
  [property: string]: unknown;
};

export type FakeFigmaOptions = {
  fileKey?: string | Error | undefined;
  fileName?: string;
};

type ExportCall = { nodeId: string; settings: { format: string; constraint?: unknown } };

type CollectionSpec = {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  key?: string;
  remote?: boolean;
};

type VariableSpec = {
  id: string;
  name: string;
  resolvedType: VariableResolvedDataType;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  key?: string;
  remote?: boolean;
  description?: string;
  scopes?: unknown;
};

type StyleSpec = {
  id: string;
  name: string;
  type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  key?: string;
  remote?: boolean;
  description?: string;
  [property: string]: unknown;
};

export function createFakeFigma(options: FakeFigmaOptions = {}) {
  const fileKey = 'fileKey' in options ? options.fileKey : 'FAKEKEY';
  const nodes = new Map<string, object>();
  const library = new Map<string, BaseNode>();
  const images = new Map<string, Uint8Array | Error>();
  const collections = new Map<string, Surface & { remote: boolean; variableIds: string[] }>();
  const variables = new Map<string, object>();
  const styles = new Map<string, StyleSpec>();
  const brokenIds = new Set<string>();
  const listeners = new Map<string, (() => void)[]>();
  const posted: unknown[] = [];
  const exportCalls: ExportCall[] = [];
  const shownUi: { html: string; options: unknown }[] = [];
  let nextId = 1;

  const root = {
    id: '0:0',
    name: options.fileName ?? 'Fixture',
    type: 'DOCUMENT',
    parent: null,
    children: [] as object[],
  };
  const page = {
    id: '0:1',
    name: 'Page 1',
    type: 'PAGE',
    parent: root,
    children: [] as object[],
    selection: [] as readonly object[],
  };
  root.children.push(page);

  function descendants(node: object): object[] {
    const { children = [] } = node as { children?: object[] };
    return children.flatMap((child) => [child, ...descendants(child)]);
  }

  function node<T extends FakeNodeType>(
    type: T,
    spec: NodeSpec = {},
  ): Extract<BaseNode, { type: T }> {
    const { id, name, children, main, segments, renders = {}, throwing = [], ...props } = spec;
    const surface: Surface = { ...CORE, ...SURFACES[type] };
    for (const key of Object.keys(props)) {
      if (!(key in surface)) throw new TypeError(`${type} has no ${key}`);
    }

    const nodeId = id ?? `${nextId}:${nextId}`;
    nextId += 1;
    const built: Surface & { parent: object | null } = {
      id: nodeId,
      name: name ?? type.toLowerCase(),
      type,
      parent: null,
      removed: false,
      ...surface,
      ...props,
      async exportAsync(settings: ExportCall['settings']) {
        exportCalls.push({ nodeId, settings });
        const format = settings.format as keyof typeof DEFAULT_RENDERS;
        const render = renders[format] ?? DEFAULT_RENDERS[format];
        if (render instanceof Error) throw render;
        return render;
      },
    };

    if (CONTAINERS.has(type)) {
      built.children = children ?? [];
      for (const child of children ?? []) (child as { parent: object }).parent = built;
      built.findAllWithCriteria = ({ types }: { types: string[] }) =>
        descendants(built).filter((found) => types.includes((found as { type: string }).type));
    }
    if (type === 'INSTANCE') {
      built.getMainComponentAsync = async () => {
        if (main instanceof Error) throw main;
        return main ?? null;
      };
      Object.defineProperty(built, 'mainComponent', {
        get() {
          throw new Error('mainComponent is write-only under dynamic-page');
        },
      });
    }
    if (type === 'COMPONENT') {
      const definitions = built.componentPropertyDefinitions;
      Object.defineProperty(built, 'componentPropertyDefinitions', {
        get() {
          const parent = built.parent as { type?: string } | null;
          if (parent?.type === 'COMPONENT_SET') {
            throw new Error('Variants have no component property definitions');
          }
          return definitions;
        },
      });
    }
    if (type === 'TEXT') {
      built.getStyledTextSegments = () => {
        if (segments instanceof Error) throw segments;
        return (segments ?? []).map((run) => ({ textStyleId: '', fillStyleId: '', ...run }));
      };
    }
    for (const key of throwing) {
      Object.defineProperty(built, key, {
        get() {
          throw new Error(`Cannot read ${key}`);
        },
      });
    }

    nodes.set(nodeId, built);
    return built as unknown as Extract<BaseNode, { type: T }>;
  }

  async function lookup<T>(id: string, table: ReadonlyMap<string, T>): Promise<T | null> {
    if (brokenIds.has(id)) throw new Error(`Cannot resolve ${id}`);
    return table.get(id) ?? null;
  }

  function imported(key: string, type: string): Promise<BaseNode> {
    const published = library.get(key);
    return published?.type === type
      ? Promise.resolve(published)
      : Promise.reject(new Error(`No published ${type} with key ${key}`));
  }

  const localStyles = async (type: StyleSpec['type']) =>
    [...styles.values()].filter((style) => style.type === type && !style.remote);

  const ui = {
    onmessage: undefined as ((message: unknown, props: { origin: string }) => void) | undefined,
    postMessage(message: unknown) {
      posted.push(structuredClone(message));
    },
  };

  const figma = {
    get fileKey() {
      if (fileKey instanceof Error) throw fileKey;
      return fileKey;
    },
    root,
    currentPage: page,
    mixed: Symbol('figma.mixed'),
    ui,
    showUI(html: string, showOptions: unknown) {
      shownUi.push({ html, options: showOptions });
    },
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    getNodeByIdAsync: (id: string) => lookup(id, nodes),
    getImageByHash(hash: string) {
      const image = images.get(hash);
      if (!image) return null;
      return {
        hash,
        async getBytesAsync() {
          if (image instanceof Error) throw image;
          return image;
        },
      };
    },
    importComponentByKeyAsync: (key: string) => imported(key, 'COMPONENT'),
    importComponentSetByKeyAsync: (key: string) => imported(key, 'COMPONENT_SET'),
    getLocalPaintStylesAsync: () => localStyles('PAINT'),
    getLocalTextStylesAsync: () => localStyles('TEXT'),
    getLocalEffectStylesAsync: () => localStyles('EFFECT'),
    getLocalGridStylesAsync: () => localStyles('GRID'),
    getStyleByIdAsync: (id: string) => lookup(id, styles),
    variables: {
      getLocalVariableCollectionsAsync: async () =>
        [...collections.values()].filter((collection) => !collection.remote),
      getVariableByIdAsync: (id: string) => lookup(id, variables),
      getVariableCollectionByIdAsync: (id: string) => lookup(id, collections),
    },
  };

  return {
    figma: figma as unknown as PluginAPI,
    mixed: figma.mixed,
    node,
    posted,
    exportCalls,
    shownUi,
    select(selection: readonly BaseNode[]) {
      page.selection = selection;
    },
    remove(removed: BaseNode) {
      nodes.delete(removed.id);
    },
    /** Makes a component or set importable by its key. */
    publish(published: ComponentNode | ComponentSetNode) {
      library.set(published.key, published);
    },
    addImage(hash: string, bytes: Uint8Array | Error) {
      images.set(hash, bytes);
    },
    addCollection({ modes, key = '', remote = false, ...spec }: CollectionSpec) {
      const defaultModeId = modes[0]?.modeId;
      collections.set(spec.id, { ...spec, key, remote, modes, defaultModeId, variableIds: [] });
    },
    addVariable({ key = '', remote = false, description = '', ...spec }: VariableSpec) {
      const scopes = 'scopes' in spec ? spec.scopes : ['ALL_SCOPES'];
      variables.set(spec.id, { ...spec, key, remote, description, scopes });
      if (!remote) collections.get(spec.variableCollectionId)?.variableIds.push(spec.id);
    },
    addStyle({ key = '', remote = false, description = '', ...spec }: StyleSpec) {
      styles.set(spec.id, { boundVariables: {}, ...spec, key, remote, description });
    },
    /** Makes a style or variable lookup by this id reject. */
    breakLookup(id: string) {
      brokenIds.add(id);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    fromUi(message: unknown) {
      ui.onmessage?.(message, { origin: 'null' });
    },
  };
}

export type FakeFigma = ReturnType<typeof createFakeFigma>;
