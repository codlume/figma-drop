import { describe, expect, it } from 'vite-plus/test';
import { exportNode } from './export-node.ts';
import { createFakeFigma } from './testing/fake-figma.ts';

describe('figma-components entries', () => {
  it('enters a component root as itself, with every field', async () => {
    const fake = createFakeFigma();
    const root = fake.node('COMPONENT', {
      id: '1:1',
      name: 'Size=md',
      key: 'k1',
      description: 'A button',
    });

    const { components } = await exportNode(fake.figma, root);

    expect(components).toEqual([
      {
        id: '1:1',
        name: 'Size=md',
        key: 'k1',
        type: 'COMPONENT',
        description: 'A button',
        remote: false,
        componentSetId: null,
        variantValues: { Size: 'md' },
      },
    ]);
  });

  it('turns an empty key into null and keeps an empty description', async () => {
    const fake = createFakeFigma();
    const { components } = await exportNode(fake.figma, fake.node('COMPONENT', { name: 'Plain' }));
    expect(components?.[0]).toMatchObject({ key: null, description: '' });
    expect(components?.[0]).not.toHaveProperty('variantValues');
  });

  it('enters a set root and its variants, each variant pointing at the set', async () => {
    const fake = createFakeFigma();
    const variant = fake.node('COMPONENT', { id: '2:2', name: 'Size=md' });
    const set = fake.node('COMPONENT_SET', { id: '2:1', name: 'Button', children: [variant] });

    const { components } = await exportNode(fake.figma, set);

    expect(components).toMatchObject([
      { id: '2:1', type: 'COMPONENT_SET', componentSetId: null },
      { id: '2:2', type: 'COMPONENT', componentSetId: '2:1' },
    ]);
  });

  it('enters an instance as its main component and never as itself', async () => {
    const fake = createFakeFigma();
    const main = fake.node('COMPONENT', { id: '3:1', name: 'Main' });
    const root = fake.node('INSTANCE', { id: '3:2', main });

    const { components } = await exportNode(fake.figma, root);

    expect(components).toMatchObject([{ id: '3:1', name: 'Main' }]);
  });

  it('does not add a variant’s parent set unless the set is in the tree', async () => {
    const fake = createFakeFigma();
    const variant = fake.node('COMPONENT', { id: '4:2', name: 'Size=md' });
    fake.node('COMPONENT_SET', { id: '4:1', children: [variant] });

    const { components } = await exportNode(fake.figma, fake.node('INSTANCE', { main: variant }));

    expect(components).toMatchObject([{ id: '4:2', componentSetId: '4:1' }]);
    expect(components).toHaveLength(1);
  });

  it('counts nested and hidden instances, one entry per id, first found first', async () => {
    const fake = createFakeFigma();
    const first = fake.node('COMPONENT', { id: '5:1', name: 'First' });
    const second = fake.node('COMPONENT', { id: '5:2', name: 'Second' });
    const third = fake.node('COMPONENT', { id: '5:3', name: 'Third' });
    const root = fake.node('FRAME', {
      children: [
        fake.node('INSTANCE', {
          main: first,
          children: [fake.node('INSTANCE', { main: second })],
        }),
        fake.node('INSTANCE', { main: first }),
        fake.node('INSTANCE', { main: third, visible: false }),
      ],
    });

    const { components } = await exportNode(fake.figma, root);

    expect(components).toMatchObject([{ id: '5:1' }, { id: '5:2' }, { id: '5:3' }]);
    expect(components).toHaveLength(3);
  });

  it('yields nothing for a leaf root and skips an unresolved instance', async () => {
    const fake = createFakeFigma();
    const leaf = await exportNode(fake.figma, fake.node('RECTANGLE'));
    const unresolved = await exportNode(
      fake.figma,
      fake.node('FRAME', {
        children: [
          fake.node('INSTANCE', { main: null }),
          fake.node('INSTANCE', { main: new Error('gone') }),
        ],
      }),
    );
    expect(leaf.components).toEqual([]);
    expect(unresolved.components).toEqual([]);
  });
});

describe('remote masters', () => {
  it('stays empty when nothing is remote', async () => {
    const fake = createFakeFigma();
    const raw = await exportNode(fake.figma, fake.node('COMPONENT', { key: 'local' }));
    expect(raw.remoteMasters).toEqual([]);
    expect(raw.summary).toMatchObject({ remoteMastersResolved: 0, remoteMasterErrors: [] });
  });

  it('resolves a component with no set', async () => {
    const fake = createFakeFigma();
    const definitions = { 'Label#1:0': { type: 'TEXT', defaultValue: 'Go' } };
    const master = fake.node('COMPONENT', {
      name: 'Library Button',
      key: 'rk',
      description: 'From the library',
      remote: true,
      componentPropertyDefinitions: definitions,
    });
    fake.publish(master);
    const stale = fake.node('COMPONENT', { name: 'Button', key: 'rk', remote: true });

    const raw = await exportNode(fake.figma, fake.node('INSTANCE', { main: stale }));

    expect(raw.components).toEqual([
      expect.objectContaining({
        name: 'Button',
        masterName: 'Library Button',
        description: 'From the library',
        componentPropertyDefinitions: definitions,
      }),
    ]);
    expect(raw.components?.[0]).not.toHaveProperty('setName');
    expect(raw.remoteMasters).toMatchObject([{ id: master.id, type: 'COMPONENT' }]);
    expect(raw.summary).toMatchObject({ remoteMastersResolved: 1, sets: [] });
  });

  it('keeps the entry’s description and drops empty definitions when the master has neither', async () => {
    const fake = createFakeFigma();
    fake.publish(fake.node('COMPONENT', { key: 'rk', remote: true }));
    const main = fake.node('COMPONENT', { key: 'rk', remote: true, description: 'Mine' });

    const { components } = await exportNode(fake.figma, fake.node('INSTANCE', { main }));

    expect(components?.[0]).toMatchObject({ description: 'Mine' });
    expect(components?.[0]).not.toHaveProperty('componentPropertyDefinitions');
  });

  it('resolves a variant through its set and serializes the set once per set key', async () => {
    const fake = createFakeFigma();
    const definitions = { Size: { type: 'VARIANT', defaultValue: 'md' } };
    const md = fake.node('COMPONENT', { name: 'Size=md', key: 'v-md', remote: true });
    const lg = fake.node('COMPONENT', { name: 'Size=lg', key: 'v-lg', remote: true });
    const set = fake.node('COMPONENT_SET', {
      name: 'Button',
      key: 'set-key',
      remote: true,
      componentPropertyDefinitions: definitions,
      children: [md, lg],
    });
    fake.publish(md);
    fake.publish(lg);

    const raw = await exportNode(
      fake.figma,
      fake.node('FRAME', {
        children: [fake.node('INSTANCE', { main: md }), fake.node('INSTANCE', { main: lg })],
      }),
    );

    expect(raw.components).toEqual([
      expect.objectContaining({
        masterName: 'Size=md',
        setName: 'Button',
        setKey: 'set-key',
        variantProperties: { Size: ['md', 'lg'] },
        componentPropertyDefinitions: definitions,
      }),
      expect.objectContaining({ masterName: 'Size=lg', setName: 'Button' }),
    ]);
    expect(raw.remoteMasters).toMatchObject([{ id: set.id, type: 'COMPONENT_SET' }]);
    expect(raw.remoteMasters).toHaveLength(1);
    expect(raw.summary).toMatchObject({
      remoteMastersResolved: 1,
      components: { total: 2, local: 0, remote: 2 },
      sets: [{ name: 'Button', axes: { Size: ['md', 'lg'] } }],
    });
  });

  it('imports a remote set through the set API', async () => {
    const fake = createFakeFigma();
    const set = fake.node('COMPONENT_SET', {
      name: 'Toggle',
      key: 'set-key',
      remote: true,
      children: [fake.node('COMPONENT', { name: 'On=yes' })],
    });
    fake.publish(set);

    const raw = await exportNode(fake.figma, set);

    expect(raw.components?.[0]).toMatchObject({
      masterName: 'Toggle',
      setName: 'Toggle',
      setKey: 'set-key',
      variantProperties: { On: ['yes'] },
    });
    expect(raw.remoteMasters).toHaveLength(1);
  });

  it('records a failed import without touching the other entries', async () => {
    const fake = createFakeFigma();
    const good = fake.node('COMPONENT', { name: 'Good', key: 'good', remote: true });
    const bad = fake.node('COMPONENT', { name: 'Bad', key: 'bad', remote: true });
    fake.publish(good);

    const raw = await exportNode(
      fake.figma,
      fake.node('FRAME', {
        children: [fake.node('INSTANCE', { main: bad }), fake.node('INSTANCE', { main: good })],
      }),
    );

    expect(raw.components?.[0]).toMatchObject({
      name: 'Bad',
      masterError: 'No published COMPONENT with key bad',
    });
    expect(raw.components?.[0]).not.toHaveProperty('masterName');
    expect(raw.components?.[1]).toMatchObject({ name: 'Good', masterName: 'Good' });
    expect(raw.remoteMasters).toHaveLength(1);
    expect(raw.summary).toMatchObject({
      remoteMastersResolved: 1,
      remoteMasterErrors: [{ name: 'Bad', error: 'No published COMPONENT with key bad' }],
    });
  });

  it('skips a remote entry with no key', async () => {
    const fake = createFakeFigma();
    const main = fake.node('COMPONENT', { name: 'Keyless', remote: true });

    const raw = await exportNode(fake.figma, fake.node('INSTANCE', { main }));

    expect(raw.components?.[0]).not.toHaveProperty('masterError');
    expect(raw.remoteMasters).toEqual([]);
  });

  it('caps each master at 5000 nodes without marking the export truncated', async () => {
    const fake = createFakeFigma();
    const children = Array.from({ length: 5001 }, () => fake.node('RECTANGLE'));
    const master = fake.node('COMPONENT', { key: 'big', remote: true, children });
    fake.publish(master);

    const raw = await exportNode(fake.figma, fake.node('INSTANCE', { main: master }));

    const masterChildren = raw.remoteMasters?.[0] as { children: Record<string, unknown>[] };
    expect(masterChildren.children[4998]).not.toHaveProperty('truncated');
    expect(masterChildren.children[4999]).toHaveProperty('truncated', true);
    expect(masterChildren.children[5000]).toHaveProperty('truncated', true);
    expect(raw.summary).toMatchObject({ truncated: false, truncatedAt: null });
  });
});
