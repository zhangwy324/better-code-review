// The center pane. The interactive graph (#30) replaces this; until then it lists what the
// selection contains, so that selecting in one pane visibly drives the others.
import { useModel, useSelection } from './state.tsx';

export function Canvas() {
  const model = useModel();
  const { selection, select } = useSelection();
  const group =
    selection?.kind === 'group'
      ? model.groups.get(selection.id)
      : selection?.kind === 'node'
        ? model.homeGroup.get(selection.id)
        : undefined;
  return (
    <section className="pane canvas" aria-label="Canvas">
      {group === undefined ? (
        <p className="hint">Select a group in the outline.</p>
      ) : (
        <>
          <h2>{group.title}</h2>
          <ul className="cards">
            {group.nodeIds.flatMap((id) => {
              const node = model.nodes.get(id);
              if (node === undefined) return [];
              return [
                <li key={id}>
                  <button
                    type="button"
                    className="card"
                    aria-current={(selection?.kind === 'node' && selection.id === id) || undefined}
                    onClick={() => select({ kind: 'node', id })}
                  >
                    <strong>{node.displayName}</strong>
                    <span className="path">{node.path}</span>
                  </button>
                </li>,
              ];
            })}
          </ul>
        </>
      )}
    </section>
  );
}
